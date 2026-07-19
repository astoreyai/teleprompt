import { createRoot } from 'react-dom/client'
import { Overlay } from './Overlay'
import { ErrorBoundary } from '../shared/ErrorBoundary'
import './overlay.css'

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary surface="overlay">
    <Overlay />
  </ErrorBoundary>,
)
