import { render, screen, act } from '@testing-library/react';
import RootRoute from './RootRoute';

jest.mock('./firebase', () => ({ auth: {} }));

let authCallback = null;
jest.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth, callback) => {
    authCallback = callback;
    return jest.fn();
  },
}));

// RootRoute renders the real App for a signed-in visitor; App itself is
// a large component with its own extensive test coverage (App.test.js),
// so here it's stubbed to a simple marker — this test is only about
// which component RootRoute picks, not App's own behavior.
jest.mock('./App', () => () => <div>THE_APP_DASHBOARD</div>);
jest.mock('./landing/LandingPage', () => () => <div>THE_LANDING_PAGE</div>);

beforeEach(() => { authCallback = null; });

test('public-launch hardening: before the first auth callback fires, shows a loading shell — never guesses', () => {
  render(<RootRoute />);
  expect(screen.queryByText('THE_APP_DASHBOARD')).toBeNull();
  expect(screen.queryByText('THE_LANDING_PAGE')).toBeNull();
  expect(screen.getByText(/Preparing your intelligence workspace/i)).toBeInTheDocument();
});

test('public-launch hardening: logged-out visitor at "/" sees the public landing experience, not the app or a bare sign-in form', () => {
  render(<RootRoute />);
  act(() => authCallback(null));
  expect(screen.getByText('THE_LANDING_PAGE')).toBeInTheDocument();
  expect(screen.queryByText('THE_APP_DASHBOARD')).toBeNull();
});

test('public-launch hardening: authenticated visitor at "/" goes straight to the app/dashboard, not the marketing page', () => {
  render(<RootRoute />);
  act(() => authCallback({ uid: 'u1' }));
  expect(screen.getByText('THE_APP_DASHBOARD')).toBeInTheDocument();
  expect(screen.queryByText('THE_LANDING_PAGE')).toBeNull();
});
