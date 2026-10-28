import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { NoticeProvider } from './api';
import App from './App';
import './styles.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <NoticeProvider>
        <App />
      </NoticeProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
