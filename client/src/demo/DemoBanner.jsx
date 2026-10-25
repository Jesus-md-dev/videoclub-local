import { useLocation } from 'react-router-dom';
import { DEMO_REPO_URL } from './index';

const link = { color: 'inherit', textDecoration: 'underline' };

export default function DemoBanner() {
  // En el reproductor (pantalla completa fija) una pastilla centrada y
  // flotante, para no tapar la cabecera; en el resto, una franja en el flujo.
  const floating = useLocation().pathname.startsWith('/watch');
  const style = {
    background: '#e9c46a',
    color: '#0c1a33',
    textAlign: 'center',
    fontSize: '0.8rem',
    padding: '0.3rem 0.5rem',
    position: floating ? 'fixed' : 'relative',
    zIndex: 1000,
    ...(floating && { top: 6, left: '50%', transform: 'translateX(-50%)', borderRadius: 999, whiteSpace: 'nowrap', padding: '0.2rem 0.8rem' }),
  };
  return (
    <div style={style}>
      <strong>Demo</strong>
      {floating ? ' - ' : ' - fictional titles and synthetic video, no server behind it. '}
      <a href={DEMO_REPO_URL} target="_blank" rel="noreferrer" style={link}>
        View on GitHub
      </a>
    </div>
  );
}
