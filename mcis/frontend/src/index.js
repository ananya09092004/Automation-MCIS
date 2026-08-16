import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import Pair from './Pair';
import reportWebVitals from './reportWebVitals';
import { setupAuthenticatedFetch } from './authFetch';

setupAuthenticatedFetch();

const root = ReactDOM.createRoot(document.getElementById('root'));

const isPairPage = window.location.pathname === '/pair';

root.render(
  <React.StrictMode>
    {isPairPage ? <Pair /> : <App />}
  </React.StrictMode>
);

reportWebVitals();