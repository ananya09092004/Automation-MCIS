import { render, screen } from '@testing-library/react';
import LandingPage, { FEATURES } from './LandingPage';

test('landing: states the product and every capability, with links to get started and the API', () => {
  render(<LandingPage />);
  expect(screen.getByRole('heading', { level: 1, name: 'Nexus' })).toBeInTheDocument();
  expect(screen.getByText('The secure execution and collaboration layer for business AI agents.')).toBeInTheDocument();
  for (const t of ['Connect tools', 'Create workflows', 'Assign AI work', 'Approve sensitive actions', 'Verify results', 'Track usage', 'Collaborate with your team']) {
    expect(screen.getByText(t)).toBeInTheDocument();
  }
  expect(screen.getByRole('link', { name: 'Get started free' })).toHaveAttribute('href', '/onboarding');
  expect(screen.getAllByRole('link', { name: /API/ })[0]).toHaveAttribute('href', '/developers');
});

test('landing: no unsupported claims (autonomy, guarantees, certifications, unlimited)', () => {
  const { container } = render(<LandingPage />);
  const text = container.textContent;
  expect(text).not.toMatch(/fully autonomous|autonomous business|guarantee|zero risk|risk-free|100%|SOC ?2|ISO ?27001|HIPAA|GDPR[- ]certified|certified|unlimited automation|never makes mistakes/i);
  expect(text).toMatch(/AI agents can make mistakes/);
  expect(FEATURES).toHaveLength(7);
});
