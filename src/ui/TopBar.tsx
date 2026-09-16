import { useRef } from 'react'
import { useStore } from '@/state/store'
import { useEditor } from './editor-context'
import {
  IconExport,
  IconFrame,
  IconLiquid,
  IconOpen,
  IconPause,
  IconPlay,
  IconRedo,
  IconReset,
  IconTrash,
  IconUndo,
  IconVector,
} from './icons'

export const TopBar = () => {
  const editor = useEditor()
  const fileInput = useRef<HTMLInputElement>(null)

  const canUndo = useStore((s) => s.canUndo)
  const canRedo = useStore((s) => s.canRedo)
  const running = useStore((s) => s.physics.running)
  const liquidVisible = useStore((s) => s.liquid.visible)
  const patchPhysics = useStore((s) => s.patchPhysics)
  const patchLiquid = useStore((s) => s.patchLiquid)
  const patch = useStore((s) => s.patch)

  const openProject = async (file: File | undefined): Promise<void> => {
    if (!file) return
    try {
      await editor.loadProject(file)
      patch({ notice: null })
    } catch (error) {
      patch({
        notice:
          error instanceof Error ? error.message : 'Could not open that file',
      })
    }
  }

  return (
    <header className="topbar">
      <div className="brand">
        <b>drawi</b>
        <span>matter lab</span>
      </div>

      <button
        type="button"
        className="btn icon"
        title="Undo (Ctrl+Z)"
        disabled={!canUndo}
        onClick={() => editor.undo()}
      >
        <IconUndo />
      </button>
      <button
        type="button"
        className="btn icon"
        title="Redo (Ctrl+Shift+Z)"
        disabled={!canRedo}
        onClick={() => editor.redo()}
      >
        <IconRedo />
      </button>

      <div className="spacer" />

      <button
        type="button"
        className={`btn${running ? ' active' : ''}`}
        title="Run or pause the simulation"
        onClick={() => patchPhysics({ running: !running })}
      >
        {running ? <IconPause /> : <IconPlay />}
        {running ? 'Pause' : 'Simulate'}
      </button>
      <button
        type="button"
        className="btn icon"
        title="Reset every body to its drawn shape"
        onClick={() => editor.resetPhysics()}
      >
        <IconReset />
      </button>

      <button
        type="button"
        className={`btn${liquidVisible ? ' active' : ''}`}
        title="Show the implicit liquid surface"
        onClick={() => patchLiquid({ visible: !liquidVisible })}
      >
        <IconLiquid />
        Liquid
      </button>
      <button
        type="button"
        className="btn"
        title="Trace the liquid surface into editable vector shapes"
        onClick={() => {
          const created = editor.vectorizeLiquid()
          patch({
            notice:
              created > 0
                ? `Traced ${created} shape${created === 1 ? '' : 's'} from the field`
                : 'Nothing in the field to trace — join some shapes to the liquid first',
          })
        }}
      >
        <IconVector />
        Vectorize
      </button>

      <div className="spacer" />

      <button
        type="button"
        className="btn icon"
        title="Frame everything"
        onClick={() => editor.frameAll()}
      >
        <IconFrame />
      </button>
      <button
        type="button"
        className="btn icon"
        title="Open project"
        onClick={() => fileInput.current?.click()}
      >
        <IconOpen />
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          void openProject(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <button
        type="button"
        className="btn"
        title="Save the project as JSON"
        onClick={() => editor.saveProject()}
      >
        <IconExport />
        Save
      </button>
      <button
        type="button"
        className="btn ghost"
        title="Export vector SVG"
        onClick={() => editor.exportSVG()}
      >
        SVG
      </button>
      <button
        type="button"
        className="btn ghost"
        title="Export PNG at 2x"
        onClick={() => editor.exportPNG(2)}
      >
        PNG
      </button>
      <button
        type="button"
        className="btn icon danger"
        title="Clear the canvas"
        onClick={() => editor.clearAll()}
      >
        <IconTrash />
      </button>
    </header>
  )
}
