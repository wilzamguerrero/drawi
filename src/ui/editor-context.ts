import { createContext, useContext } from 'react'
import type { Editor } from '@/app/editor'

/**
 * The editor instance is shared through context rather than props: panels are
 * scattered across the layout and every one of them issues commands, but none
 * of them owns it.
 */
export const EditorContext = createContext<Editor | null>(null)

export const useEditor = (): Editor => {
  const editor = useContext(EditorContext)
  if (!editor) throw new Error('Editor is not mounted')
  return editor
}
