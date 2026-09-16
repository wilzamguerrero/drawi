import { useState, type ReactNode } from 'react'

/** Small, uniform control primitives so every panel reads the same way. */

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** Decimal places shown in the readout. */
  precision?: number
  suffix?: string
  onChange: (value: number) => void
}

export const Slider = ({
  label,
  value,
  min,
  max,
  step = 0.01,
  precision = 2,
  suffix = '',
  onChange,
}: SliderProps) => (
  <div className="row">
    <label title={label}>{label}</label>
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="value">
        {value.toFixed(precision)}
        {suffix}
      </span>
    </div>
  </div>
)

interface ToggleProps {
  label: string
  value: boolean
  onChange: (value: boolean) => void
}

export const Toggle = ({ label, value, onChange }: ToggleProps) => (
  <div className="row">
    <label title={label}>{label}</label>
    <button
      type="button"
      className={`toggle${value ? ' on' : ''}`}
      aria-pressed={value}
      aria-label={label}
      onClick={() => onChange(!value)}
    />
  </div>
)

interface SegmentedProps<T extends string> {
  label?: string
  value: T
  options: Array<{ value: T; label: string; title?: string }>
  onChange: (value: T) => void
}

export const Segmented = <T extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedProps<T>) => {
  const control = (
    <div className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title ?? option.label}
          className={option.value === value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
  if (!label) return control
  return (
    <div className="row">
      <label title={label}>{label}</label>
      {control}
    </div>
  )
}

interface SectionProps {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  right?: ReactNode
}

export const Section = ({
  title,
  children,
  defaultOpen = true,
  right,
}: SectionProps) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="section">
      <header onClick={() => setOpen(!open)}>
        <span>
          {open ? '▾' : '▸'} {title}
        </span>
        <span onClick={(e) => e.stopPropagation()}>{right}</span>
      </header>
      {open && <div className="body">{children}</div>}
    </section>
  )
}

const PALETTE = [
  '#e8e6e1',
  '#ffffff',
  '#0b0c0f',
  '#ff7a6b',
  '#ffc460',
  '#8ee6a0',
  '#6cc4ff',
  '#b38cff',
  '#ff8ecb',
]

interface ColorPickerProps {
  value: string
  onChange: (value: string) => void
}

export const ColorPicker = ({ value, onChange }: ColorPickerProps) => (
  <>
    <div className="swatches">
      {PALETTE.map((color) => (
        <button
          key={color}
          type="button"
          title={color}
          aria-label={color}
          className={`swatch${color === value ? ' active' : ''}`}
          style={{ background: color }}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
    <input
      className="color-input"
      type="color"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  </>
)

/** Converts between the store's 0..1 RGB triple and an `<input type=color>`. */
export const rgbToHex = (rgb: [number, number, number]): string => {
  const channel = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`
}

export const hexToRgb = (hex: string): [number, number, number] => {
  const clean = hex.replace('#', '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean
  const value = parseInt(full, 16)
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ]
}
