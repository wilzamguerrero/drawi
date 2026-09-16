import type { ReactNode } from 'react'

/**
 * Inline icon set.
 *
 * Bundling the marks as components rather than a font or sprite keeps them
 * in the same stroke weight as the rest of the interface and lets each one
 * inherit `currentColor`, so an active tool tints without a second asset.
 */

interface IconProps {
  size?: number
}

const svg = (children: ReactNode, size: number): ReactNode => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
)

export const IconSelect = ({ size = 18 }: IconProps) =>
  svg(<path d="M5 3l6.5 16 2.2-6.4L20 10.3z" />, size)

export const IconStroke = ({ size = 18 }: IconProps) =>
  svg(
    <>
      <path d="M3 18c4.5 0 4-11 8.5-11S16 16 21 16" />
      <circle cx="21" cy="16" r="1.4" fill="currentColor" stroke="none" />
    </>,
    size
  )

export const IconFill = ({ size = 18 }: IconProps) =>
  svg(
    <path d="M4 14c0-4 3.4-7.5 7.6-7.5 3.6 0 6.4 2 7.7 5 1 2.4-.6 5.1-3.2 5.4-2.1.2-3-1.3-5.2-1.3C8.2 15.6 4 16.8 4 14z" />,
    size
  )

export const IconSplat = ({ size = 18 }: IconProps) =>
  svg(
    <>
      <path d="M9.2 5.6c2.6-1.3 5.6.3 5.9 3 .2 2 2.6 1.6 3.3 3.3.8 2-.9 4.3-3.2 4.3-1.8 0-2.2 1.9-4 2.2-2.4.4-4.3-1.6-3.9-3.8.3-1.6-1.6-2-1.9-3.6-.4-2.3 1.5-4.4 3.8-5.4z" />
      <circle cx="19.4" cy="6.4" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="5.2" cy="18.6" r="0.9" fill="currentColor" stroke="none" />
    </>,
    size
  )

export const IconBlob = ({ size = 18 }: IconProps) =>
  svg(
    <path d="M12 4c4 0 7.5 3 7.5 7s-2.6 9-7.5 9-7.5-5-7.5-9 3.5-7 7.5-7z" />,
    size
  )

export const IconGrab = ({ size = 18 }: IconProps) =>
  svg(
    <>
      <path d="M9 11V6.2a1.4 1.4 0 0 1 2.8 0V11" />
      <path d="M11.8 10.6V5.4a1.4 1.4 0 0 1 2.8 0v5.2" />
      <path d="M14.6 11V7.4a1.4 1.4 0 0 1 2.8 0V14c0 3.3-2.3 6-5.6 6-3 0-5.6-2-5.6-5v-3.3a1.3 1.3 0 0 1 2.7 0" />
    </>,
    size
  )

export const IconErase = ({ size = 18 }: IconProps) =>
  svg(
    <>
      <path d="M8.5 19.5H20" />
      <path d="M15.4 4.6l4 4a1.6 1.6 0 0 1 0 2.3l-7.6 7.6H7.9l-3.3-3.3a1.6 1.6 0 0 1 0-2.3l8.5-8.3a1.6 1.6 0 0 1 2.3 0z" />
    </>,
    size
  )

export const IconSymmetry = ({ size = 18 }: IconProps) =>
  svg(
    <>
      <path d="M12 3v18" strokeDasharray="3 3" />
      <path d="M9.4 7L5 12l4.4 5z" />
      <path d="M14.6 7L19 12l-4.4 5z" />
    </>,
    size
  )

export const IconUndo = ({ size = 16 }: IconProps) =>
  svg(
    <>
      <path d="M4 9h11a5 5 0 0 1 0 10h-6" />
      <path d="M7.5 5.5L4 9l3.5 3.5" />
    </>,
    size
  )

export const IconRedo = ({ size = 16 }: IconProps) =>
  svg(
    <>
      <path d="M20 9H9a5 5 0 0 0 0 10h6" />
      <path d="M16.5 5.5L20 9l-3.5 3.5" />
    </>,
    size
  )

export const IconPlay = ({ size = 16 }: IconProps) =>
  svg(<path d="M7 4.8v14.4L19.5 12z" fill="currentColor" />, size)

export const IconPause = ({ size = 16 }: IconProps) =>
  svg(
    <>
      <rect x="7" y="5" width="3.6" height="14" rx="1" fill="currentColor" />
      <rect x="13.4" y="5" width="3.6" height="14" rx="1" fill="currentColor" />
    </>,
    size
  )

export const IconReset = ({ size = 16 }: IconProps) =>
  svg(
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.6h-4.6" />
    </>,
    size
  )

export const IconFrame = ({ size = 16 }: IconProps) =>
  svg(
    <>
      <path d="M4 8.5V5a1 1 0 0 1 1-1h3.5" />
      <path d="M15.5 4H19a1 1 0 0 1 1 1v3.5" />
      <path d="M20 15.5V19a1 1 0 0 1-1 1h-3.5" />
      <path d="M8.5 20H5a1 1 0 0 1-1-1v-3.5" />
    </>,
    size
  )

export const IconLiquid = ({ size = 16 }: IconProps) =>
  svg(
    <>
      <path d="M3 15c2.2 0 2.2-2.2 4.4-2.2S9.6 15 11.8 15s2.2-2.2 4.4-2.2S18.4 15 21 15" />
      <path d="M3 19c2.2 0 2.2-2.2 4.4-2.2S9.6 19 11.8 19s2.2-2.2 4.4-2.2S18.4 19 21 19" />
      <circle cx="12" cy="7" r="3.2" />
    </>,
    size
  )

export const IconVector = ({ size = 16 }: IconProps) =>
  svg(
    <>
      <path d="M6 18c0-6 4-10 12-10" />
      <rect x="3" y="16" width="4" height="4" rx="1" />
      <rect x="17" y="6" width="4" height="4" rx="1" />
    </>,
    size
  )

export const IconExport = ({ size = 16 }: IconProps) =>
  svg(
    <>
      <path d="M12 15V4" />
      <path d="M8.5 7.5L12 4l3.5 3.5" />
      <path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15" />
    </>,
    size
  )

export const IconOpen = ({ size = 16 }: IconProps) =>
  svg(
    <>
      <path d="M12 4v11" />
      <path d="M8.5 11.5L12 15l3.5-3.5" />
      <path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15" />
    </>,
    size
  )

export const IconTrash = ({ size = 16 }: IconProps) =>
  svg(
    <>
      <path d="M4.5 6.5h15" />
      <path d="M9.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5" />
      <path d="M6.5 6.5l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-12" />
    </>,
    size
  )
