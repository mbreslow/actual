import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { TestProviders } from '#mocks';

import { ClassificationHintsPage } from './ClassificationHintsPage';

const setSyncedPref = vi.fn();
let categories = [
  {
    id: 'flexible',
    name: 'Flexible Spending',
    hidden: false,
  },
  {
    id: 'dining',
    name: 'Dining Out',
    hidden: false,
  },
];
let syncedHints = '{}';

vi.mock('#hooks/useCategories', () => ({
  useCategories: () => ({
    data: {
      list: categories,
      grouped: [],
    },
  }),
}));

vi.mock('#hooks/useSyncedPref', () => ({
  useSyncedPref: () => [syncedHints, setSyncedPref],
}));

describe('ClassificationHintsPage', () => {
  beforeEach(() => {
    setSyncedPref.mockClear();
    syncedHints = '{}';
    categories = [
      {
        id: 'flexible',
        name: 'Flexible Spending',
        hidden: false,
      },
      {
        id: 'dining',
        name: 'Dining Out',
        hidden: false,
      },
    ];
  });

  it('renders one editable row for each category', () => {
    render(<ClassificationHintsPage />, { wrapper: TestProviders });

    expect(screen.getByText('Flexible Spending')).toBeInTheDocument();
    expect(screen.getByText('Dining Out')).toBeInTheDocument();
    expect(screen.getByLabelText('Hints for Flexible Spending')).toHaveValue(
      '',
    );
  });

  it('saves edited hints by category id', async () => {
    const user = userEvent.setup();
    render(<ClassificationHintsPage />, { wrapper: TestProviders });

    await user.type(
      screen.getByLabelText('Hints for Flexible Spending'),
      'movies, entertainment, activities',
    );
    await user.tab();

    expect(setSyncedPref).toHaveBeenCalledWith(
      JSON.stringify({
        flexible: 'movies, entertainment, activities',
      }),
    );
  });

  it('keeps hints associated with the same category after a rename', () => {
    syncedHints = JSON.stringify({
      flexible: 'movies, entertainment, activities',
    });
    categories = [
      {
        id: 'flexible',
        name: 'Fun Money',
        hidden: false,
      },
    ];

    render(<ClassificationHintsPage />, { wrapper: TestProviders });

    expect(screen.getByLabelText('Hints for Fun Money')).toHaveValue(
      'movies, entertainment, activities',
    );
  });
});
