import { useStore } from '@/state/store'

export const StatusBar = () => {
  const stats = useStore((s) => s.stats)
  const tool = useStore((s) => s.tool)
  const symmetry = useStore((s) => s.symmetry)
  const running = useStore((s) => s.physics.running)

  const instances =
    symmetry.enabled
      ? (symmetry.mirror ? 2 : 1) *
        (symmetry.mirrorPerpendicular ? 2 : 1) *
        Math.max(1, Math.round(symmetry.radial))
      : 1

  return (
    <footer className="status">
      <span>
        <span className={`dot${stats.fps > 45 ? ' live' : ' warm'}`} />
        {stats.fps} fps · {stats.frameMs.toFixed(1)} ms
      </span>
      <span>
        {stats.drawn}/{stats.objects} drawn
      </span>
      <span>{stats.sources} field sources</span>
      <span>
        <span className={`dot${running ? ' live' : ''}`} />
        {stats.bodies} bodies · {stats.particles} particles
      </span>
      <span>
        {stats.realPressure ? 'stylus pressure' : 'speed-derived pressure'}
      </span>
      {instances > 1 && <span>×{instances} symmetry</span>}
      <span className="spacer" />
      <span>tool: {tool}</span>
      <span>space or middle drag pans · wheel zooms</span>
    </footer>
  )
}
