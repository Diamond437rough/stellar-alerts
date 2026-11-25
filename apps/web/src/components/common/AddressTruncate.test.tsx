import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AddressTruncate } from './AddressTruncate';

const G_ADDRESS = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';
const C_ADDRESS = `C${'A'.repeat(54)}D`;
const TX_HASH = '0123456789abcdef'.repeat(4);

describe('AddressTruncate', () => {
  it('truncates a 56-character G-address into prefix...suffix with defaults', () => {
    render(<AddressTruncate value={G_ADDRESS} />);

    expect(screen.getByText('GBZXN7...DNMADI')).toBeInTheDocument();
  });

  it('uses the full value as both tooltip title and aria-label', () => {
    render(<AddressTruncate value={G_ADDRESS} />);

    const address = screen.getByTestId('address-truncate');
    expect(address).toHaveAttribute('title', G_ADDRESS);
    expect(address).toHaveAttribute('aria-label', G_ADDRESS);
    expect(screen.getByLabelText(G_ADDRESS)).toBe(address);
  });

  it('respects configurable prefix and suffix lengths for a C-address', () => {
    render(<AddressTruncate value={C_ADDRESS} prefixChars={4} suffixChars={4} />);

    expect(screen.getByText('CAAA...AAAD')).toBeInTheDocument();
  });

  it('truncates 64-character transaction hashes', () => {
    render(<AddressTruncate value={TX_HASH} prefixChars={10} suffixChars={6} />);

    expect(screen.getByText('0123456789...abcdef')).toBeInTheDocument();
  });

  it('does not truncate strings shorter than the threshold', () => {
    render(<AddressTruncate value="GABC" />);

    expect(screen.getByText('GABC')).toBeInTheDocument();
  });

  it('does not truncate when the length equals prefix plus suffix', () => {
    render(<AddressTruncate value="GABCXYZ9" prefixChars={4} suffixChars={4} />);

    expect(screen.getByText('GABCXYZ9')).toBeInTheDocument();
  });

  it('renders an empty value without an ellipsis', () => {
    render(<AddressTruncate value="" />);

    expect(screen.getByTestId('address-truncate')).toBeEmptyDOMElement();
  });

  it('supports a zero suffix without repeating the whole value', () => {
    render(<AddressTruncate value={TX_HASH} prefixChars={8} suffixChars={0} />);

    expect(screen.getByText('01234567...')).toBeInTheDocument();
  });

  it('applies an optional class name', () => {
    render(<AddressTruncate value={G_ADDRESS} className="font-mono" />);

    expect(screen.getByTestId('address-truncate')).toHaveClass('font-mono');
  });
});
