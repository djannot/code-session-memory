import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import SearchPage from "./pages/SearchPage";
import SessionsPage from "./pages/SessionsPage";
import SessionDetailPage from "./pages/SessionDetailPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import StatusPage from "./pages/StatusPage";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<SearchPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/status" element={<StatusPage />} />
      </Route>
    </Routes>
  );
}
