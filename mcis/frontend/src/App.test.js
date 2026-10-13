import { render, screen } from '@testing-library/react';
import App from './App';

jest.mock('./firebase', () => ({ auth: {} }));

jest.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth, callback) => {
    callback(null);
    return jest.fn();
  },
  signOut: jest.fn(),
  createUserWithEmailAndPassword: jest.fn(),
  signInWithEmailAndPassword: jest.fn(),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }) => <div>{children}</div>,
}));

jest.mock('react-syntax-highlighter', () => ({ Prism: ({ children }) => <pre>{children}</pre> }));
jest.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({ oneDark: {} }));
jest.mock('./components/dashboard', () => () => <div>Workspace</div>);

test('shows the memory-first sign-in experience when signed out', () => {
  render(<App />);

  expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  expect(screen.getByText(/persistent memory/i)).toBeInTheDocument();
});
