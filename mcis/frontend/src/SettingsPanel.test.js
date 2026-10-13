import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsPanel from './SettingsPanel';

// C3 (security hardening, pre-launch): regression coverage for the new
// Data Controls tab -- export and delete-my-data, both scoped to the
// signed-in Firebase user (auth.currentUser.uid), never a client-typed
// id. Firebase itself is mocked; these are component-level tests for
// the UI's own loading/error/success states and confirm-before-delete
// gating, not an end-to-end test of the real backend (see
// mcis/backend/__tests__/hardening.test.js's "P-SEC-5 data controls"
// tests for that).
jest.mock('./firebase', () => ({
  auth: { currentUser: { uid: 'u1', email: 'u1@example.com', emailVerified: true } },
}));
jest.mock('firebase/auth', () => ({
  sendPasswordResetEmail: jest.fn(),
  sendEmailVerification: jest.fn(),
}));

let calls;

beforeEach(() => {
  calls = [];
  global.fetch = jest.fn();
});

function openDataTab() {
  render(<SettingsPanel userId="u1" onClose={() => {}} />);
  fireEvent.click(screen.getByText('Data controls'));
}

test('data controls: export calls GET on the SIGNED-IN user\'s own uid, never a typed-in id', async () => {
  global.fetch.mockImplementation((url) => {
    calls.push({ url: String(url) });
    return Promise.resolve({
      ok: true,
      json: async () => ({ success: true, tables: { goals: [] }, skippedTables: [] }),
    });
  });
  // jsdom doesn't implement anchor-click navigation / URL.createObjectURL;
  // stub them so the download side-effect doesn't throw.
  global.URL.createObjectURL = jest.fn(() => 'blob:fake');
  global.URL.revokeObjectURL = jest.fn();

  openDataTab();
  expect(screen.queryByPlaceholderText(/userid|user id/i)).toBeNull();

  fireEvent.click(screen.getByText('Export my data'));
  expect(screen.getByText('Preparing export...')).toBeInTheDocument();

  await waitFor(() => expect(screen.getByText(/downloaded to your device/i)).toBeInTheDocument());

  expect(calls).toHaveLength(1);
  expect(calls[0].url).toContain('/api/data-controls/u1/export');
  expect(calls[0].url).not.toContain('u2');
});

test('data controls: export surfaces a server error instead of a silent failure', async () => {
  global.fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Could not export user data' }) });

  openDataTab();
  fireEvent.click(screen.getByText('Export my data'));

  await waitFor(() => expect(screen.getByText('Could not export user data')).toBeInTheDocument());
});

test('data controls: deletion is refused until the user types DELETE, and the button stays disabled until then', async () => {
  openDataTab();
  fireEvent.click(screen.getByText('Delete my data'));

  expect(screen.getByText(/this cannot be undone/i)).toBeInTheDocument();
  const confirmBtn = screen.getByText('Permanently delete my data');
  expect(confirmBtn).toBeDisabled();

  fireEvent.change(screen.getByPlaceholderText('Type DELETE to confirm'), { target: { value: 'delete' } });
  expect(confirmBtn).toBeDisabled();

  fireEvent.change(screen.getByPlaceholderText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
  expect(confirmBtn).not.toBeDisabled();

  expect(global.fetch).not.toHaveBeenCalled();
});

test('data controls: deletion shows a loading state while the request is in flight', async () => {
  let resolveFetch;
  global.fetch.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));

  openDataTab();
  fireEvent.click(screen.getByText('Delete my data'));
  fireEvent.change(screen.getByPlaceholderText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
  fireEvent.click(screen.getByText('Permanently delete my data'));

  await waitFor(() => expect(screen.getByText('Deleting...')).toBeInTheDocument());

  resolveFetch({ ok: true, json: async () => ({ success: true, results: [] }) });
  await waitFor(() => expect(screen.getByText(/account data has been deleted/i)).toBeInTheDocument());
});

test('data controls: confirmed deletion calls DELETE on the signed-in user\'s own uid and shows a success state', async () => {
  global.fetch.mockImplementation((url, opts) => {
    calls.push({ url: String(url), method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : undefined });
    return Promise.resolve({ ok: true, json: async () => ({ success: true, results: [] }) });
  });

  openDataTab();
  fireEvent.click(screen.getByText('Delete my data'));
  fireEvent.change(screen.getByPlaceholderText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
  fireEvent.click(screen.getByText('Permanently delete my data'));

  await waitFor(() => expect(screen.getByText(/account data has been deleted/i)).toBeInTheDocument());

  expect(calls).toHaveLength(1);
  expect(calls[0].url).toContain('/api/data-controls/u1');
  expect(calls[0].method).toBe('DELETE');
  expect(calls[0].body).toEqual({ confirm: 'DELETE' });
});

test('data controls: a failed deletion shows an error and does not falsely claim success', async () => {
  global.fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Could not delete user data' }) });

  openDataTab();
  fireEvent.click(screen.getByText('Delete my data'));
  fireEvent.change(screen.getByPlaceholderText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
  fireEvent.click(screen.getByText('Permanently delete my data'));

  await waitFor(() => expect(screen.getByText('Could not delete user data')).toBeInTheDocument());
  expect(screen.queryByText(/account data has been deleted/i)).toBeNull();
});

test('data controls: cancel returns to the initial (non-confirming) state without calling the API', () => {
  openDataTab();
  fireEvent.click(screen.getByText('Delete my data'));
  fireEvent.change(screen.getByPlaceholderText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
  fireEvent.click(screen.getByText('Cancel'));

  expect(screen.getByText('Delete my data')).toBeInTheDocument();
  expect(screen.queryByPlaceholderText('Type DELETE to confirm')).toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
});
