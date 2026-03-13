import { useState, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import SessionDetail from "../components/SessionDetail";
import ConfirmDialog from "../components/ConfirmDialog";
import { useSessionDetail } from "../hooks/useSessionDetail";

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { session, chunks, analytics, loading, error, deleteSession } = useSessionDetail(id || "");
  const [showDelete, setShowDelete] = useState(false);
  const [highlightedChunkId, setHighlightedChunkId] = useState<string | null>(null);

  // Scroll to chunk when hash is present and chunks have loaded
  useEffect(() => {
    if (!loading && chunks.length > 0 && location.hash) {
      const chunkId = location.hash.slice(1); // remove '#'
      setHighlightedChunkId(chunkId.replace("chunk-", ""));
      // Small delay to ensure DOM has rendered
      requestAnimationFrame(() => {
        const el = document.getElementById(chunkId);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    }
  }, [loading, chunks.length, location.hash]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <svg className="w-6 h-6 animate-spin text-violet-400" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass rounded-xl p-4 text-sm text-red-700 bg-red-100/30 shadow-sm">
        {error}
      </div>
    );
  }

  if (!session) {
    return (
      <div className="text-center py-12 text-gray-400">
        Session not found.
      </div>
    );
  }

  const handleDelete = async () => {
    await deleteSession();
    navigate("/sessions");
  };

  return (
    <>
      <button
        onClick={() => navigate("/sessions")}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4 transition-colors cursor-pointer"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to sessions
      </button>

      <SessionDetail
        session={session}
        chunks={chunks}
        analytics={analytics}
        onDelete={() => setShowDelete(true)}
        highlightedChunkId={highlightedChunkId}
      />

      <ConfirmDialog
        open={showDelete}
        title="Delete session"
        message="This will permanently remove this session and all its chunks from the database."
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setShowDelete(false)}
      />
    </>
  );
}
