import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { getCurrentUser, logoutAccount } from "./auth";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);

  useEffect(() => {
    let active = true;
    getCurrentUser()
      .then(({ user: currentUser }) => {
        if (active) setUser(currentUser);
      })
      .catch((error) => {
        if (!error.message.startsWith("Not signed in") && !error.message.startsWith("Session expired")) {
          console.error("Could not restore account session.", error);
        }
      });
    return () => { active = false; };
  }, []);

  const logout = useCallback(async () => {
    await logoutAccount();
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, setUser, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider.");
  return context;
}
