import { Navigate, Route, Routes } from "react-router-dom";
import Meetings from "./pages/Meetings";
import MeetingRoom from "./pages/MeetingRoom";
import AuthPage from "./pages/AuthPage";
import { AuthProvider } from "./services/AuthContext";

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Meetings />} />
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route path="/room/:roomId" element={<MeetingRoom />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
