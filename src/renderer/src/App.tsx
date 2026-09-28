import { useState } from 'react'
import type { ProjectRecord } from '@shared/types'
import AccountsView from './views/AccountsView'
import ProjectPickerView from './views/ProjectPickerView'
import ChatView from './views/ChatView'

type Screen = 'accounts' | 'projects' | 'chat'

function App() {
  const [screen, setScreen] = useState<Screen>('accounts')
  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null)

  return (
    <div className="app">
      <div className="app-nav">
        <h1>VibeApp</h1>
        <div className="app-nav-tabs">
          <button
            className={screen === 'accounts' ? 'active' : ''}
            onClick={() => setScreen('accounts')}
          >
            Accounts
          </button>
          <button
            className={screen === 'projects' || screen === 'chat' ? 'active' : ''}
            onClick={() => setScreen('projects')}
          >
            Projects
          </button>
        </div>
      </div>

      {screen === 'accounts' && <AccountsView />}
      {screen === 'projects' && (
        <ProjectPickerView
          onOpen={(project) => {
            setActiveProject(project)
            setScreen('chat')
          }}
        />
      )}
      {screen === 'chat' && activeProject && (
        <ChatView project={activeProject} onBack={() => setScreen('projects')} />
      )}
    </div>
  )
}

export default App
