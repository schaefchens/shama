import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { SelfTest } from './SelfTest.tsx';
import './styles.css';

const selfTest = new URLSearchParams(location.search).has('self-test');

createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode>{selfTest ? <SelfTest /> : <App />}</StrictMode>);
