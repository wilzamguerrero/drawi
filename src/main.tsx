import { createRoot } from 'react-dom/client'
import { App } from './ui/App'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root')

// Deliberately no StrictMode: its double mount would create and tear down a
// WebGL context and a full render loop on every hot update, which is noisy and
// occasionally exhausts the browser's context budget.
createRoot(container).render(<App />)
