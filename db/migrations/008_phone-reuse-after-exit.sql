-- Up Migration
-- A member who left can join again later as a new member with a new code (ASSUMPTIONS 107), and
-- will usually keep the same phone number. The number only has to be unique among people still in
-- the fund; an exited or deceased record keeps its number as history.
ALTER TABLE members DROP CONSTRAINT members_phone_key;
CREATE UNIQUE INDEX members_phone_current ON members (phone) WHERE status NOT IN ('exited', 'deceased');

-- Down Migration
DROP INDEX members_phone_current;
ALTER TABLE members ADD CONSTRAINT members_phone_key UNIQUE (phone);
