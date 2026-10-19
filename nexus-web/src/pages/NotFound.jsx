import { EmptyState } from '../components/ui.jsx';
import { Link } from '../lib/router.jsx';

export default function NotFound() {
  return <EmptyState title="Page not found" action={<Link to="/" className="link">Go to the dashboard</Link>}>The page you opened does not exist.</EmptyState>;
}
