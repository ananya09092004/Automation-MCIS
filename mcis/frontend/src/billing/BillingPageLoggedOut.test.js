import { render, screen } from '@testing-library/react';
import BillingPage from './BillingPage';

// Customer-funnel audit: a logged-out visitor who follows the public
// "Pricing" link (Landing -> /billing) must not hit a dead end — they
// need a way to continue into sign-in/sign-up, not a bare "Please sign
// in." with no link anywhere on the page.
jest.mock('../firebase', () => ({ auth: { currentUser: null } }));
jest.mock('firebase/auth', () => ({ onAuthStateChanged: (_a, cb) => { cb(null); return () => {}; } }));

test('billing page: a logged-out visitor sees a working link into sign-in/sign-up, not a dead end', async () => {
  render(<BillingPage />);
  const link = await screen.findByRole('link', { name: /sign in or create an account/i });
  expect(link).toHaveAttribute('href', '/signin');
});
