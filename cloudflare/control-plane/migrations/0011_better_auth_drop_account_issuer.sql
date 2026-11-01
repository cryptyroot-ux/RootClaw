-- Better Auth 1.7.3 stopped writing account.issuer. The 1.7.1 column is NOT
-- NULL, so every new account insert fails. SQLite has no ALTER COLUMN.
DROP INDEX account_issuer_accountId_uidx;
ALTER TABLE account DROP COLUMN issuer;
