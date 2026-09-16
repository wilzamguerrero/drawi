import { useStore, type ToolId } from '@/state/store'
import {
  IconBlob,
  IconErase,
  IconFill,
  IconGrab,
  IconSelect,
  IconSplat,
  IconStroke,
  IconSymmetry,
} from './icons'

interface ToolDef {
  id: ToolId
  label: string
  key: string
  icon: JSX.Element
  /** Tools below the divider act on what already exists. */
  group: 'create' | 'act'
}

/**
 * Tool rail.
 *
 * The split matters: the top group makes marks, the bottom group changes what
 * marks already are. That mirrors the whole premise — you create first and
 * decide what the thing *is* afterwards.
 */
const TOOLS: ToolDef[] = [
  { id: 'stroke', label: 'Stroke', key: 'B', icon: <IconStroke />, group: 'create' },
  { id: 'fill', label: 'Fill', key: 'F', icon: <IconFill />, group: 'create' },
  { id: 'splat', label: 'Splat', key: 'X', icon: <IconSplat />, group: 'create' },
  { id: 'blob', label: 'Blob', key: 'O', icon: <IconBlob />, group: 'create' },
  { id: 'select', label: 'Select', key: 'V', icon: <IconSelect />, group: 'act' },
  { id: 'grab', label: 'Grab', key: 'G', icon: <IconGrab />, group: 'act' },
  { id: 'erase', label: 'Erase', key: 'E', icon: <IconErase />, group: 'act' },
  {
    id: 'symmetry',
    label: 'Place symmetry axis',
    key: 'M',
    icon: <IconSymmetry />,
    group: 'act',
  },
]

export const Toolbar = () => {
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)

  return (
    <nav className="rail">
      {TOOLS.map((def, index) => (
        <div key={def.id} style={{ display: 'contents' }}>
          {index > 0 && TOOLS[index - 1].group !== def.group && (
            <div className="divider" />
          )}
          <button
            type="button"
            className={`tool${tool === def.id ? ' active' : ''}`}
            title={`${def.label} (${def.key})`}
            aria-label={def.label}
            aria-pressed={tool === def.id}
            onClick={() => setTool(def.id)}
          >
            {def.icon}
            <span className="key">{def.key}</span>
          </button>
        </div>
      ))}
    </nav>
  )
}
