BEGIN;

-- Theme has_one_attached :static_map in the legacy Rails model. This attachment
-- is data-bearing even though it is not visible in themes table columns.
INSERT INTO active_storage_attachments(
  id, name, record_type, record_id, blob_id, created_at
) VALUES (
  110, 'static_map', 'Theme', 60, 100, '2020-10-02'
);

-- Real deployments may contain extension/custom tables wider than Rails' own
-- models. This deliberately exceeds one jsonb_build_object chunk so capture
-- cannot depend on PostgreSQL's function-argument ceiling.
CREATE TABLE community_extension_wide (
  id bigint PRIMARY KEY,
  c01 text, c02 text, c03 text, c04 text, c05 text,
  c06 text, c07 text, c08 text, c09 text, c10 text,
  c11 text, c12 text, c13 text, c14 text, c15 text,
  c16 text, c17 text, c18 text, c19 text, c20 text,
  c21 text, c22 text, c23 text, c24 text, c25 text,
  c26 text, c27 text, c28 text, c29 text, c30 text,
  c31 text, c32 text, c33 text, c34 text, c35 text,
  c36 text, c37 text, c38 text, c39 text, c40 text,
  c41 text, c42 text, c43 text, c44 text, c45 text,
  c46 text, c47 text, c48 text, c49 text, c50 text,
  c51 text, c52 text, c53 text, c54 text, c55 text
);

INSERT INTO community_extension_wide VALUES (
  1,
  '01','02','03','04','05','06','07','08','09','10',
  '11','12','13','14','15','16','17','18','19','20',
  '21','22','23','24','25','26','27','28','29','30',
  '31','32','33','34','35','36','37','38','39','40',
  '41','42','43','44','45','46','47','48','49','50',
  '51','52','53','54','55'
);

COMMIT;
