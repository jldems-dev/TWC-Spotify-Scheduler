import React, { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

class RendererErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Renderer failed to render:', error, info.componentStack);
    window.dispatchEvent(new CustomEvent('twc:startup-error', { detail: error.message }));
  }

  render() {
    if (this.state.error) {
      return <main className="startup-error" role="alert">
        <h1>The app could not display this page</h1>
        <p>{this.state.error.message}</p>
        <small>See the Electron console for details. Restart the app after correcting the error.</small>
      </main>;
    }
    return this.props.children;
  }
}

function StartupReady() {
  useEffect(() => {
    window.dispatchEvent(new Event('twc:app-ready'));
  }, []);
  return null;
}

const root = document.getElementById('root');
if (!root) throw new Error('The renderer root element #root is missing from index.html.');
createRoot(root).render(<React.StrictMode><RendererErrorBoundary><><App /><StartupReady /></></RendererErrorBoundary></React.StrictMode>);
