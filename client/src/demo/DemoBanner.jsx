import { DEMO_REPO_URL } from './index';

export default function DemoBanner() {
  return (
    <div
      style={{
        background: '#e9c46a',
        color: '#0c1a33',
        textAlign: 'center',
        fontSize: '0.8rem',
        padding: '0.3rem 0.5rem',
        position: 'relative',
        zIndex: 1000,
      }}
    >
      <strong>Demo</strong> - fictional titles and synthetic video, no server behind it.{' '}
      <a href={DEMO_REPO_URL} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>
        View on GitHub
      </a>
    </div>
  );
}
