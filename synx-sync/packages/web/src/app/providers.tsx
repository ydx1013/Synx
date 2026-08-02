import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider';
import { App } from '../App';
import type { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false },
    },
  });
  return <QueryClientProvider client={queryClient}><BrowserRouter><AuthProvider>{children}</AuthProvider></BrowserRouter></QueryClientProvider>;
}

export function AppShell() {
  return <Providers><App /></Providers>;
}
