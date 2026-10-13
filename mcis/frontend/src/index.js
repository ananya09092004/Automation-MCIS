import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import RootRoute from './RootRoute';
import Pair from './Pair';
import WorkflowsPage from './workflows/WorkflowsPage';
import IntegrationsPage from './integrations/IntegrationsPage';
import SecurityPage from './security/SecurityPage';
import BillingPage from './billing/BillingPage';
import OnboardingPage from './onboarding/OnboardingPage';
import WorkspacePage from './workspace/WorkspacePage';
import DevelopersPage from './developers/DevelopersPage';
import LandingPage from './landing/LandingPage';
import CompetitorPage from './revenue/CompetitorPage';
import MonitoringPage from './revenue/MonitoringPage';
import ReliabilityPage from './revenue/ReliabilityPage';
import WorkforcePage from './revenue/WorkforcePage';
import reportWebVitals from './reportWebVitals';
import { setupAuthenticatedFetch } from './authFetch';

setupAuthenticatedFetch();

const root = ReactDOM.createRoot(document.getElementById('root'));

const isPairPage = window.location.pathname === '/pair';
const isWorkflowsPage = window.location.pathname === '/workflows';
const isIntegrationsPage = window.location.pathname === '/integrations';
const isSecurityPage = window.location.pathname === '/security';
const isBillingPage = window.location.pathname === '/billing';
// The actual sign-in/sign-up form — what `/` used to render
// unconditionally. LandingPage's "Sign in" links point here, so a
// logged-out visitor can always reach it directly without `/` (now the
// public landing experience for them — see RootRoute) looping back on
// itself. <App/> renders the Auth form itself for a logged-out visitor,
// exactly as it already did at `/`.
const isSignInPage = window.location.pathname === '/signin';
// Layer 8 customer journey pages.
const LAYER8_PAGES = {
  '/onboarding': OnboardingPage,
  '/workspace': WorkspacePage,
  '/developers': DevelopersPage,
  '/welcome': LandingPage,
  // Layer 10 revenue suite
  '/competitors': CompetitorPage,
  '/monitoring': MonitoringPage,
  '/reliability': ReliabilityPage,
  '/workforce': WorkforcePage,
};
const Layer8Page = LAYER8_PAGES[window.location.pathname] || null;
const isRootPage = window.location.pathname === '/';

root.render(
  <React.StrictMode>
    {isPairPage ? <Pair />
      : isWorkflowsPage ? <WorkflowsPage />
      : isIntegrationsPage ? <IntegrationsPage />
      : isSecurityPage ? <SecurityPage />
      : isBillingPage ? <BillingPage />
      : isSignInPage ? <App />
      : Layer8Page ? <Layer8Page />
      // `/` itself: public landing experience when logged out, the
      // app/dashboard when authenticated (public-launch hardening pass).
      : isRootPage ? <RootRoute />
      : <App />}
  </React.StrictMode>
);

reportWebVitals();