import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './api/client';
import { routes } from './App';
import { initTheme } from './lib/theme';
import { ConfirmProvider } from './ui/Dialog';
import { ToastProvider } from './ui/Toast';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/markdown.css';
import './styles/layout.css';
import './styles/features.css';
import './styles/solve.css';
import './styles/solutions.css';
import './styles/preferences.css';

async function start() {
  // `npm run dev:mock` serves the UI against an in-memory implementation of
  // the API. The condition is resolved at build time, so the mock is never
  // part of a production bundle.
  if (import.meta.env.VITE_MOCK === '1') {
    const { installMock } = await import('./mock');
    installMock();
  }

  initTheme();

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        // Client errors will not go away by asking again; transport and server errors might.
        retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });

  const router = createBrowserRouter(routes);

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ConfirmProvider>
            <RouterProvider router={router} />
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void start();
