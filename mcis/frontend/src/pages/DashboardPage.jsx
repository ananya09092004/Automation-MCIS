import React, { useEffect, useState } from 'react';
import Dashboard from '../components/Step6_Dashboard';
import { auth } from '../services/firebase'; // Your Firebase config

const DashboardPage = () => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((authUser) => {
      setUser(authUser);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const handleLogout = async () => {
    await auth.signOut();
    window.location.href = '/login'; // Or use your router
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen h-[100dvh] bg-gray-900 px-4 text-center">
        <p className="text-gray-400 text-sm sm:text-base">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen h-[100dvh] bg-gray-900 px-4 text-center">
        <p className="text-gray-400 text-sm sm:text-base">Please log in</p>
      </div>
    );
  }

  return (
    <Dashboard
      userId={user.uid}
      userName={user.displayName || user.email}
      onLogout={handleLogout}
    />
  );
};

export default DashboardPage;