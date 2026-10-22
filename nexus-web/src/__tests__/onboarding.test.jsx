// Guided setup on the real onboarding API (shapes mirror a live backend run).
import { describe, it, expect } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderApp, fakeApi, overviewFixture, WS_TEAM, WS_PERSONAL } from './helpers.jsx';

const NEWCO = { id: '44444444-4444-4444-8444-444444444444', name: 'NewCo', is_personal: false, role: 'owner' };
const USE_CASES = [{ id: 'research', label: 'Research & analysis' }, { id: 'reporting', label: 'Reporting' }];
const TEMPLATE = { id: 'company_research', name: 'Company research', description: 'Research a company', riskLevel: 'green', expectedOutput: 'A sourced brief', onboarding: true, available: true, requiresApproval: false, permissions: ['agent actions'], inputs: [{ name: 'company', label: 'Company', type: 'text', required: true }, { name: 'website', label: 'Website', type: 'text', required: true }] };
const view = (over) => ({ enabled: true, started: true, completed: false, step: 'workspace', personalWorkspaceId: WS_PERSONAL.id, workspaceId: WS_PERSONAL.id, companyWorkspaceId: null, useCases: USE_CASES, steps: ['workspace', 'team', 'use_case', 'template', 'first_run', 'done'], ...over });

function flowApi(initial) {
  let list = [WS_PERSONAL];
  let state = initial;
  const set = (s) => { state = s; return s; };
  return fakeApi([
    ['GET', /^\/api\/onboarding$/, () => state],
    ['POST', /^\/api\/onboarding\/start$/, () => set(view({}))],
    ['POST', /^\/api\/onboarding\/workspace$/, (m, o) => { list = [WS_PERSONAL, { ...NEWCO, name: o.body.name }]; return set(view({ step: 'team', companyWorkspaceId: NEWCO.id, workspaceId: NEWCO.id })); }],
    ['POST', /^\/api\/onboarding\/team$/, () => set(view({ step: 'use_case', companyWorkspaceId: NEWCO.id, workspaceId: NEWCO.id, invitesSkipped: true }))],
    ['POST', /^\/api\/onboarding\/use-case$/, () => set(view({ step: 'template', companyWorkspaceId: NEWCO.id, workspaceId: NEWCO.id, useCase: 'research', recommendedTemplates: [TEMPLATE] }))],
    ['POST', /^\/api\/onboarding\/template$/, () => set(view({ step: 'first_run', companyWorkspaceId: NEWCO.id, workspaceId: NEWCO.id, useCase: 'research', templateId: TEMPLATE.id, firstWorkflowId: 'wf1' }))],
    ['POST', /^\/api\/onboarding\/first-run$/, () => set(view({ step: 'done', completed: true, companyWorkspaceId: NEWCO.id, workspaceId: NEWCO.id, firstRunId: 'run1', run: { id: 'run1', status: 'queued' } }))],
    ['GET', /\/templates/, [TEMPLATE]],
    ['GET', /^\/api\/workspaces$/, () => list],
    ['GET', /\/overview$/, overviewFixture()],
    ['GET', /\/agents$/, []],
  ]);
}

describe('guided setup', () => {
  it('the dashboard invites a brand-new user to set up', async () => {
    renderApp({ api: flowApi({ enabled: true, started: false, completed: false, required: true, useCases: USE_CASES }), path: '/' });
    expect(await screen.findByText('Set up Nexus in about three minutes')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get started' })).toHaveAttribute('href', '/welcome');
  });

  it('existing users who never started are not nagged', async () => {
    renderApp({ api: flowApi({ enabled: true, started: false, completed: false, required: false, useCases: USE_CASES }), path: '/' });
    await screen.findByTestId('stat-succeeded');
    expect(screen.queryByText(/Set up Nexus/)).not.toBeInTheDocument();
  });

  it('walks through every step on the real endpoints and validates the first-run inputs', async () => {
    const api = flowApi({ enabled: true, started: false, completed: false, required: true, useCases: USE_CASES });
    renderApp({ api, path: '/welcome' });
    fireEvent.click(await screen.findByRole('button', { name: 'Start setup' }));
    fireEvent.change(await screen.findByLabelText('Company workspace name'), { target: { value: 'NewCo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Research & analysis' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use this workflow' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start first run' }));
    expect(await screen.findByText('Company is required.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Company *'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText('Website *'), { target: { value: 'acme.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start first run' }));
    expect(await screen.findByText('You are set up')).toBeInTheDocument();
    const posts = api.calls.filter((c) => c.method === 'POST').map((c) => c.path.replace('/api/onboarding', ''));
    expect(posts).toEqual(['/start', '/workspace', '/team', '/use-case', '/template', '/first-run']);
    expect(api.calls.find((c) => c.path.endsWith('/first-run')).body).toEqual({ inputs: { company: 'Acme', website: 'acme.example' } });
    await waitFor(() => expect(screen.getByLabelText('Workspace')).toHaveValue(NEWCO.id));
  });

  it('resuming at the template step reloads templates from the server', async () => {
    const api = flowApi(view({ step: 'template', companyWorkspaceId: NEWCO.id, workspaceId: NEWCO.id, useCase: 'research' }));
    renderApp({ api, path: '/welcome' });
    expect(await screen.findByRole('button', { name: 'Use this workflow' })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === `/api/workspaces/${NEWCO.id}/templates?useCase=research`)).toBe(true);
  });
});
