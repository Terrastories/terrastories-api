-- An effective erasure is irreversible; system lifecycle authority cannot reopen content.
CREATE TRIGGER communities_erasure_no_reactivation
BEFORE UPDATE OF is_active ON communities
WHEN NEW.is_active = 1 AND EXISTS (
  SELECT 1 FROM community_sovereignty_requests r
  WHERE r.community_id = OLD.id AND r.kind = 'erasure'
    AND r.state IN ('requested', 'executing', 'completed')
)
BEGIN
  SELECT RAISE(ABORT, 'Community erasure in progress');
END;
