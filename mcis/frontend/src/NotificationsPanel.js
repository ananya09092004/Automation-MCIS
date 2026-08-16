import { useState, useEffect } from 'react';

function NotificationsPanel({ userId, darkMode }) {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(false);

  const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || 'https://mcis-backend.onrender.com';

  useEffect(() => {
    if (!userId) return;
    loadNotifications();
    
    // Auto refresh every 15 seconds
    const interval = setInterval(loadNotifications, 15000);
    return () => clearInterval(interval);
  }, [userId]);

  const loadNotifications = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${BACKEND_URL}/api/notifications/${userId}`);
      const data = await res.json();
      if (data.success) {
        setNotifications(data.notifications || []);
      }
    } catch (err) {
      console.error('Notifications error:', err);
    } finally {
      setLoading(false);
    }
  };

  const markAsRead = async (notifId) => {
    try {
      await fetch(`${BACKEND_URL}/api/notifications/${notifId}/read`, {
        method: 'PATCH'
      });
      loadNotifications();
    } catch (err) {
      console.error('Read error:', err);
    }
  };

  if (!userId || notifications.length === 0) return null;

  return (
    <div style={{
      background: darkMode ? '#1a1a2e' : '#f9f9f9',
      border: `1px solid ${darkMode ? '#2a2a4a' : '#e0e0e0'}`,
      borderRadius: 12,
      padding: 12,
      marginBottom: 12
    }}>
      <h4 style={{ margin: '0 0 8px 0', fontSize: 12, fontWeight: 600 }}>
        💡 Suggestions ({notifications.length})
      </h4>

      <div style={{ maxHeight: 250, overflowY: 'auto' }}>
        {notifications.slice(0, 5).map(notif => (
          <div
            key={notif.id}
            style={{
              padding: 8,
              marginBottom: 6,
              background: darkMode ? '#2a2a4a' : '#fff',
              border: `1px solid ${darkMode ? '#3a3a5a' : '#e0e0e0'}`,
              borderRadius: 6,
              borderLeft: `2px solid ${notif.type === 'suggestion' ? '#6c63ff' : notif.type === 'attention' ? '#ff6b6b' : '#ffa500'}`,
              opacity: notif.read ? 0.5 : 1,
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
            onClick={() => markAsRead(notif.id)}
          >
            <p style={{ 
              margin: 0, 
              fontSize: 11, 
              lineHeight: 1.4,
              color: darkMode ? '#e0e0e0' : '#333'
            }}>
              {notif.message}
            </p>
            <small style={{ color: '#888', fontSize: 10, marginTop: 4, display: 'block' }}>
              {new Date(notif.created_at).toLocaleDateString()}
            </small>
          </div>
        ))}
      </div>
    </div>
  );
}

export default NotificationsPanel;