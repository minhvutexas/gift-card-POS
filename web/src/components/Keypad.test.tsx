import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { AmountKeypad } from './Keypad';
import { StatusPill } from './ui';

function Harness({ onEnter }: { onEnter?: () => void }) {
  const [v, setV] = useState(0);
  return <AmountKeypad value={v} onChange={setV} onEnter={onEnter} error={v > 2200 ? 'Insufficient: $22.00 available' : null} />;
}

afterEach(cleanup);

describe('AmountKeypad', () => {
  it('builds an amount from taps and warns when over balance', () => {
    render(<Harness />);
    for (const k of ['2', '5', '0', '0']) fireEvent.click(screen.getByRole('button', { name: k }));
    expect(screen.getByText('$25.00')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Insufficient: $22.00 available');
    fireEvent.click(screen.getByRole('button', { name: 'Backspace' }));
    expect(screen.getByText('$2.50')).toBeTruthy();
  });

  it('accepts physical keyboard digits and Enter', () => {
    const onEnter = vi.fn();
    render(<Harness onEnter={onEnter} />);
    const pad = screen.getByRole('group', { name: 'Amount keypad' });
    fireEvent.keyDown(pad, { key: '1' });
    fireEvent.keyDown(pad, { key: '0' });
    fireEvent.keyDown(pad, { key: 'Enter' });
    expect(screen.getByText('$0.10')).toBeTruthy();
    expect(onEnter).toHaveBeenCalledOnce();
  });
});

describe('StatusPill', () => {
  it('renders text + glyph, not colour alone', () => {
    render(<StatusPill status="PARTIALUSED" />);
    expect(screen.getByText('Partially used')).toBeTruthy();
    expect(screen.getByText('◐')).toBeTruthy();
  });
});
