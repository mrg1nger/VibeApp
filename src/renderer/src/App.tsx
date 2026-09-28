import { useEffect, useState } from 'react'

function App() {
  const [pong, setPong] = useState<string>('...')

  useEffect(() => {
    window.vibe.ping().then(setPong)
  }, [])

  return (
    <div className="app">
      <h1>VibeApp</h1>
      <p>Scaffold is alive. Main process says: {pong}</p>
    </div>
  )
}

export default App
