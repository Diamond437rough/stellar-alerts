/**
 * WorkerScaler
 *
 * Dynamic Adaptive Worker Auto-Scaler Using Redis Lag Metrics and Node Memory Pressure
 *
 * This addresses [BACKEND] Dynamic Adaptive Worker Auto-Scaler Using Redis Lag Metrics and Node Memory Pressure (#915)
 *
 * Scales worker concurrency dynamically based on:
 * - Redis queue backlog depth
 * - Event Loop lag (event loop delay)
 * - Node memory pressure (heap usage)
 *
 * Scales concurrency between MIN_WORKERS (5) and MAX_WORKERS (50)
 */

import { createLogger } from './logger';
import Redis from 'ioredis';
import { EventEmitter } from 'events';

const log = createLogger({ module: 'WorkerScaler' });

/** Minimum worker concurrency */
export const MIN_WORKERS = 5;
/** Maximum worker concurrency */
export const MAX_WORKERS = 50;
/** Target event loop lag threshold in ms (below = scale up) */
export const TARGET_EVENT_LOOP_LAG_MS = 20;
/** Maximum event loop lag before scaling down (ms) */
export const MAX_EVENT_LOOP_LAG_MS = 50;
/** Memory pressure threshold before scaling down (percentage of heap used) */
export const MEMORY_PRESSURE_THRESHOLD = 0.8; // 80% */
/** Redis queue backlog depth threshold before scaling up */
export const QUEUE_BACKLOG_THRESHOLD = 500;
/** Cool-down period between scale decisions (ms) */
export const SCALE_COOLDOWN_MS = 30_000;
/** How many ledgers behind before scaling up aggressively */
export const REDIS_LAG_THRESHOLD = 1000;

/**
 * Current scaling state
 */
enum ScalingDirection {
  NONE = 'none',
  SCALE_UP = 'scale_up',
  SCALE_DOWN = 'scale_down',
}

/**
 * Metrics collected from the runtime environment for scaling decisions.
 */
export interface ScalingMetrics {
  /** Current Redis queue depth (number of pending jobs) */
  redisQueueDepth: number;
  /** Current event loop lag in milliseconds */
  eventLoopLagMs: number;
  /** Current node heap usage percentage (0.0 - 1.0) */
  memoryPressure: number;
  /** Current number of active workers */
  currentWorkers: number;
  /** Timestamp of when metrics were collected */
  timestamp: number;
}

/**
 * Scaling decision result
 */
export interface ScalingDecision {
  /** Whether a scale change is recommended */
  shouldScale: boolean;
  /** Direction to scale: NONE, SCALE_UP, or SCALE_DOWN */
  direction: ScalingDirection;
  /** Recommended worker count */
  recommendedWorkers: number;
  /** Reason for the decision */
  reason: string;
}

/**
 * State of the auto-scaler
 */
interface ScalerState {
  currentConcurrency: number;
  lastScaleDecision: number; // epoch ms
  lastMetrics: ScalingMetrics | null;
}

/**
 * Auto-scaler that dynamically adjusts worker concurrency based on runtime metrics.
 *
 * The scaler monitors:
 * 1. Redis queue backlog depth - scale up when deep, scale down when shallow
 * 2. Event loop lag - scale down when lag is high (CPU bound), scale up when lag is low
 * 3. Node memory pressure - scale down when memory is tight, scale up when memory is headroom
 *
 * Decision logic:
 * - Scale UP if: queueDepth > QUEUE_BACKLOG_THRESHOLD AND eventLoopLagMs < TARGET_EVENT_LOOP_LAG_MS
 * - Scale DOWN if: eventLoopLagMs > MAX_EVENT_LOOP_LAG_MS OR memoryPressure > MEMORY_PRESSURE_THRESHOLD
 * - Otherwise: maintain current concurrency
 *
 * Enforces cool-down between decisions and hard bounds [MIN_WORKERS, MAX_WORKERS].
 */
export class WorkerScaler extends EventEmitter {
  private redis: Redis;
  private state: ScalerState;
  private scaleInProgress = false;

  constructor(redis: Redis, initialConcurrency = MIN_WORKERS) {
    super();
    this.redis = redis;
    this.state = {
      currentConcurrency: initialConcurrency,
      lastScaleDecision: 0,
      lastMetrics: null,
    };
  }

  /**
   * Collect current scaling metrics from Redis and the Node.js process.
   */
  async collectMetrics(): Promise<ScalingMetrics> {
    // Get Redis queue depth - check the default bullmq queue length
    let redisQueueDepth = 0;
    try {
      // BLLEN returns the number of items in the list
      redisQueueDepth = await this.redis.llen('bull:default');
      if (typeof redisQueueDepth !== 'number') {
        redisQueueDepth = 0;
      }
    } catch (err) {
      log.warn({ err }, '⚠️ Failed to read Redis queue depth');
      redisQueueDepth = 0;
    }

    // Get event loop lag estimation based on available Node.js metrics
    // process.eventLoopUtilization and process.memory are available in Node 18+
    const eventLoopLagMs = (global as any).eventLoopUtilization
      ? Math.round((1 - (global as any).eventLoopUtilization.used * 100) * 10)
      : 0;
    // Get memory pressure - heap total vs heap used
    const heapTotal = (global as any).process?.memory?.heapTotal ?? 0;
    const heapUsed = (global as any).process?.memory?.heapUsed ?? 0;
    const memoryPressure = heapTotal > 0 ? heapUsed / heapTotal : 0;

    const metrics: ScalingMetrics = {
      redisQueueDepth,
      eventLoopLagMs,
      memoryPressure,
      currentWorkers: this.state.currentConcurrency,
      timestamp: Date.now(),
    };

    this.state.lastMetrics = metrics;
    return metrics;
  }

  /**
   * Make a scaling decision based on the current metrics.
   *
   * @returns ScalingDecision with recommendation and reason
   */
  makeDecision(): ScalingDecision {
    const metrics = this.state.lastMetrics;
    if (!metrics) {
      return {
        shouldScale: false,
        direction: ScalingDirection.NONE,
        recommendedWorkers: this.state.currentConcurrency,
        reason: 'No metrics available yet',
      };
    }

    const { redisQueueDepth, eventLoopLagMs, memoryPressure, currentWorkers } = metrics;
    const { currentConcurrency, lastScaleDecision } = this.state;
    const now = Date.now();

    // Enforce cool-down between scale decisions
    if (now - lastScaleDecision < SCALE_COOLDOWN_MS) {
      return {
        shouldScale: false,
        direction: ScalingDirection.NONE,
        recommendedWorkers: currentConcurrency,
        reason: `Cooldown active (${SCALE_COOLDOWN_MS}ms remaining)`,
      };
    }

    let direction: ScalingDirection = ScalingDirection.NONE;
    let recommendedWorkers = currentConcurrency;
    let reasonParts: string[] = [];

    // Scale UP conditions:
    // - Queue is deep AND event loop is healthy (low lag)
    if (redisQueueDepth > QUEUE_BACKLOG_THRESHOLD && eventLoopLagMs < TARGET_EVENT_LOOP_LAG_MS) {
      direction = ScalingDirection.SCALE_UP;
      recommendedWorkers = Math.min(currentConcurrency + 5, MAX_WORKERS);
      reasonParts.push(
        `queue depth ${redisQueueDepth} > ${QUEUE_BACKLOG_THRESHOLD} and event loop lag ${eventLoopLagMs}ms < ${TARGET_EVENT_LOOP_LAG_MS}ms`,
      );
    }
    // Scale DOWN conditions:
    // - Event loop lag is high (CPU bound) OR memory pressure is high
    else if (eventLoopLagMs > MAX_EVENT_LOOP_LAG_MS || memoryPressure > MEMORY_PRESSURE_THRESHOLD) {
      direction = ScalingDirection.SCALE_DOWN;
      recommendedWorkers = Math.max(currentConcurrency - 3, MIN_WORKERS);
      if (eventLoopLagMs > MAX_EVENT_LOOP_LAG_MS) {
        reasonParts.push(
          `event loop lag ${eventLoopLagMs}ms > ${MAX_EVENT_LOOP_LAG_MS}ms`,
        );
      }
      if (memoryPressure > MEMORY_PRESSURE_THRESHOLD) {
        reasonParts.push(
          `memory pressure ${(memoryPressure * 100).toFixed(1)}% > ${(MEMORY_PRESSURE_THRESHOLD * 100).toFixed(1)}%`,
        );
      }
    }
    // If queue is shallow and lag is healthy, we could scale down gradually
    else if (redisQueueDepth < QUEUE_BACKLOG_THRESHOLD / 2 && eventLoopLagMs < TARGET_EVENT_LOOP_LAG_MS) {
      // Gentle scale down if been running high for a while
      reasonParts.push(
        `queue depth ${redisQueueDepth} is low and event loop lag ${eventLoopLagMs}ms is healthy`,
      );
    }

    const reason = reasonParts.length > 0 ? reasonParts.join('; ') : 'metrics within normal ranges';

    return {
      shouldScale: direction !== ScalingDirection.NONE,
      direction,
      recommendedWorkers,
      reason,
    };
  }

  /**
   * Apply the scaling decision, updating the internal state.
   *
   * @param decision The scaling decision to apply
   * @returns True if the scale was applied, false if suppressed by bounds
   */
  applyDecision(decision: ScalingDecision): boolean {
    if (!decision.shouldScale) {
      return false;
    }

    const { direction, recommendedWorkers } = decision;
    const previousConcurrency = this.state.currentConcurrency;

    // Update state based on direction
    switch (direction) {
      case ScalingDirection.SCALE_UP:
        this.state.currentConcurrency = recommendedWorkers;
        break;
      case ScalingDirection.SCALE_DOWN:
        this.state.currentConcurrency = recommendedWorkers;
        break;
      default:
        return false;
    }

    // Emit event for workers to react to
    this.emit('scale', previousConcurrency, this.state.currentConcurrency, direction, decision.reason);

    // Record the scale decision timestamp
    this.state.lastScaleDecision = Date.now();

    log.info({
      previousConcurrency,
      newConcurrency: this.state.currentConcurrency,
      direction,
      reason: decision.reason,
    });

    return true;
  }

  /**
   * Run a complete scaling cycle: collect metrics, make decision, apply decision.
   *
   * @returns The scaling decision that was (or would be) applied
   */
  async runScalingCycle(): Promise<ScalingDecision> {
    // 1. Collect metrics
    await this.collectMetrics();

    // 2. Make decision
    const decision = this.makeDecision();

    // 3. Apply if recommended
    if (decision.shouldScale) {
      this.applyDecision(decision);
    }

    return decision;
  }

  /**
   * Get the current concurrency setting.
   */
  getCurrentConcurrency(): number {
    return this.state.currentConcurrency;
  }

  /**
   * Force a scale up to a specific number of workers.
   */
  forceScaleTo(workers: number): void {
    this.state.currentConcurrency = Math.min(
      Math.max(workers, MIN_WORKERS),
      MAX_WORKERS,
    );
    this.emit('scale', this.state.currentConcurrency, this.state.currentConcurrency, ScalingDirection.SCALE_UP, 'forced scale');
  }

  /**
   * Force a scale down to a specific number of workers.
   */
  forceScaleDownTo(workers: number): void {
    this.state.currentConcurrency = Math.min(
      Math.max(workers, MIN_WORKERS),
      MAX_WORKERS,
    );
    this.emit('scale', this.state.currentConcurrency, this.state.currentConcurrency, ScalingDirection.SCALE_DOWN, 'forced scale down');
  }
}

export default WorkerScaler;