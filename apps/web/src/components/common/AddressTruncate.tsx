import React from 'react';

export interface AddressTruncateProps {
  /** Full Stellar address or transaction hash to display. */
  value: string;
  /** Number of leading characters to keep. Defaults to 6. */
  prefixChars?: number;
  /** Number of trailing characters to keep. Defaults to 6. */
  suffixChars?: number;
  /** Additional Tailwind class names applied to the wrapper element. */
  className?: string;
}

const ELLIPSIS = '...';

export function truncateMiddle(value: string, prefixChars: number, suffixChars: number): string {
  const prefix = Math.max(0, Math.floor(prefixChars));
  const suffix = Math.max(0, Math.floor(suffixChars));

  if (value.length <= prefix + suffix) return value;

  return `${value.slice(0, prefix)}${ELLIPSIS}${suffix > 0 ? value.slice(-suffix) : ''}`;
}

/**
 * Displays a Stellar StrKey address or transaction hash in `head...tail` form
 * while keeping the complete value available as a native tooltip and as the
 * accessible name of the element.
 */
export const AddressTruncate: React.FC<AddressTruncateProps> = ({
  value,
  prefixChars = 6,
  suffixChars = 6,
  className,
}) => (
  <span
    role="img"
    aria-label={value}
    title={value}
    data-testid="address-truncate"
    className={className}
  >
    {truncateMiddle(value, prefixChars, suffixChars)}
  </span>
);

export default AddressTruncate;
