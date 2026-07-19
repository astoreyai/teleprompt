import { createRoot } from 'react-dom/client'
import { Controls } from './Controls'
import { ErrorBoundary } from '../shared/ErrorBoundary'
import './controls.css'

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary surface="controls">
    <Controls />
  </ErrorBoundary>,
)
