import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { NoticeProvider } from './api';
import App from './App';
import { ConfirmProvider } from './components/ui';
import './styles.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <NoticeProvider>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </NoticeProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
