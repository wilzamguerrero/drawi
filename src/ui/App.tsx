import { useEffect, useRef, useState } from 'react'
import { Editor } from '@/app/editor'
import { useStore } from '@/state/store'
import { EditorContext } from './editor-context'
import { Inspector } from './Inspector'
import { StatusBar } from './StatusBar'
import { Toolbar } from './Toolbar'
import { TopBar } from './TopBar'
import './styles.css'

export const App = () => {
  const stageRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<HTMLCanvasElement>(null)
  const fieldRef = useRef<HTMLCanvasElement>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const notice = useStore((s) => s.notice)
  const patch = useStore((s) => s.patch)

  useEffect(() => {
    const stage = stageRef.current
    const scene = sceneRef.current
    const field = fieldRef.current
    if (!stage || !scene || !field) return

    const instance = new Editor()
    instance.attach(stage, scene, field)
    setEditor(instance)
    return () => {
      instance.detach()
      setEditor(null)
    }
  }, [])

  return (
    <div className="app">
      {editor ? (
        <EditorContext.Provider value={editor}>
          <TopBar />
          <Toolbar />
          <Inspector />
          <StatusBar />
        </EditorContext.Provider>
      ) : (
        <header className="topbar">
          <div className="brand">
            <b>drawi</b>
            <span>matter lab</span>
          </div>
        </header>
      )}

      {/*
        The canvases live outside the conditional so the editor has something
        to attach to on the very first effect pass.
      */}
      <div className="stage" ref={stageRef}>
        <canvas ref={sceneRef} />
        <canvas className="field" ref={fieldRef} />
        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button
              type="button"
              className="btn ghost"
              onClick={() => patch({ notice: null })}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
