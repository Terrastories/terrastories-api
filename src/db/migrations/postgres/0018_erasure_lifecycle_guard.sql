CREATE FUNCTION reject_erasure_reactivation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_active AND EXISTS (
    SELECT 1 FROM community_sovereignty_requests r
    WHERE r.community_id = OLD.id AND r.kind = 'erasure'
      AND r.state IN ('requested', 'executing', 'completed')
  ) THEN
    RAISE EXCEPTION 'Community erasure in progress';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER communities_erasure_no_reactivation BEFORE UPDATE OF is_active ON communities
FOR EACH ROW EXECUTE FUNCTION reject_erasure_reactivation();
