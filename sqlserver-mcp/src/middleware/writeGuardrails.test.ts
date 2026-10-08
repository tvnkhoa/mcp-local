import assert from "node:assert/strict";
import test from "node:test";

import { validateWriteBatch } from "./writeGuardrails.js";

/** The CRM_Identity seed that motivated the lane (ADR 0006), with its USE/GO lines removed. */
const SEED = `
BEGIN TRY
    BEGIN TRANSACTION;
        DECLARE @PermissionId INT;
        DECLARE @StartOrder INT = 38;
        DECLARE @PermissionCode NVARCHAR(100) = 'globalConfiguration';
        SELECT @PermissionId = Id FROM [dbo].[Permission] WHERE [Code] = @PermissionCode;
        IF @PermissionId IS NULL
            THROW 50000, 'Permission globalConfiguration not found', 1;
        DECLARE @Operations TABLE (RowNum INT IDENTITY(0,1), Code NVARCHAR(255), Name NVARCHAR(255));
        INSERT INTO @Operations (Code, Name) VALUES ('crm.configuration.global.aria', 'Aria Market Administration');
        INSERT INTO [dbo].[Operation] ([Code], [Name], [Order], [CreatedBy], [CreatedAt])
        SELECT o.Code, o.Name, @StartOrder + o.RowNum, 'seed', GETDATE()
        FROM @Operations o
        WHERE NOT EXISTS (SELECT 1 FROM [dbo].[Operation] op WHERE op.Code = o.Code);
        INSERT INTO [dbo].[PermissionOperation] ([PermissionId], [OperationId], [CreatedBy], [CreatedAt])
        SELECT @PermissionId, op.Id, 'seed', GETDATE()
        FROM [dbo].[Operation] op
        INNER JOIN @Operations o ON op.Code = o.Code
        WHERE NOT EXISTS (SELECT 1 FROM [dbo].[PermissionOperation] po
                          WHERE po.PermissionId = @PermissionId AND po.OperationId = op.Id);
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;

-- Verify
SELECT o.Id, o.Code, o.[Order], p.Code AS PermissionCode, p.Level
FROM [dbo].[Operation] o
JOIN [dbo].[PermissionOperation] po ON po.OperationId = o.Id
JOIN [dbo].[Permission] p ON p.Id = po.PermissionId
WHERE o.Code = 'crm.configuration.global.aria';
`;

function accepts(sql: string): number {
  const result = validateWriteBatch(sql);
  assert.equal(result.ok, true, result.ok ? "" : `refused: ${result.error.message}`);
  return result.ok ? result.commitCount : -1;
}

function refuses(sql: string, pattern: RegExp): void {
  const result = validateWriteBatch(sql);
  assert.equal(result.ok, false, `accepted: ${sql}`);
  if (!result.ok) {
    assert.match(result.error.message, pattern);
  }
}

test("the motivating seed batch is accepted, with its one COMMIT counted", () => {
  assert.equal(accepts(SEED), 1);
});

test("plain DML without transaction control is accepted", () => {
  assert.equal(accepts("UPDATE dbo.T SET a = 1 WHERE id = 2;"), 0);
  accepts("DELETE FROM dbo.T WHERE id = 2");
  accepts("SET NOCOUNT OFF; MERGE INTO dbo.T AS t USING (SELECT 1 AS id) s ON t.id = s.id WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id);");
  accepts("WITH c AS (SELECT id FROM dbo.T) UPDATE dbo.T SET a = 1 WHERE id IN (SELECT id FROM c)");
  accepts("DECLARE @ids TABLE (id INT); INSERT INTO dbo.T (a) OUTPUT inserted.id INTO @ids VALUES (1); SELECT * FROM @ids;");
  accepts("SELECT id INTO #t FROM dbo.T; UPDATE dbo.T SET a = 1 WHERE id IN (SELECT id FROM #t);");
});

test("a reserved word in a literal, comment or bracketed name is not a statement", () => {
  accepts("INSERT INTO dbo.Audit ([Drop], Note) VALUES (1, 'DROP TABLE x; ROLLBACK; EXEC y') -- GRANT\n");
});

test("the client-side GO separator and USE are refused, with the fix named", () => {
  refuses("USE [CRM_Identity];\nGO\nINSERT INTO dbo.T VALUES (1)", /GO is a client-side batch separator/);
  refuses("INSERT INTO dbo.T VALUES (1)\ngo 2\n", /GO is a client-side batch separator/);
  refuses("USE CRM_Identity; INSERT INTO dbo.T VALUES (1)", /must start with/);
  refuses("INSERT INTO dbo.T VALUES (1); USE Other;", /Forbidden token in a write batch: use/);
});

test("a batch must contain a write", () => {
  refuses("SELECT 1", /no INSERT, UPDATE, DELETE or MERGE/);
});

test("a bare procedure name on line one is refused (T-SQL would execute it)", () => {
  refuses("xp_cmdshell 'dir'; INSERT INTO dbo.T VALUES (1)", /must start with/);
  refuses("dbo.DoThings; INSERT INTO dbo.T VALUES (1)", /must start with/);
});

test("DDL, permissions, dynamic SQL and remote access are refused", () => {
  for (const [sql, token] of [
    ["INSERT INTO dbo.T VALUES (1); CREATE TABLE dbo.X (a INT)", "create"],
    ["INSERT INTO dbo.T VALUES (1); ALTER TABLE dbo.T ADD b INT", "alter"],
    ["INSERT INTO dbo.T VALUES (1); DROP TABLE dbo.T", "drop"],
    ["INSERT INTO dbo.T VALUES (1); TRUNCATE TABLE dbo.T", "truncate"],
    ["INSERT INTO dbo.T VALUES (1); GRANT SELECT ON dbo.T TO x", "grant"],
    ["INSERT INTO dbo.T VALUES (1); DENY SELECT ON dbo.T TO x", "deny"],
    ["INSERT INTO dbo.T VALUES (1); EXEC sp_executesql N'x'", "exec"],
    ["INSERT INTO dbo.T VALUES (1); EXECUTE ('x')", "execute"],
    ["INSERT INTO dbo.T SELECT * FROM OPENQUERY(s, 'x')", "openquery"],
    ["INSERT INTO dbo.T SELECT * FROM OPENROWSET('a','b','c')", "openrowset"],
    ["INSERT INTO dbo.T VALUES (1); DISABLE TRIGGER t ON dbo.T", "trigger"],
    ["INSERT INTO dbo.T VALUES (1); WAITFOR DELAY '01:00'", "waitfor"]
  ] as const) {
    refuses(sql, new RegExp(`Forbidden token in a write batch: ${token}\\b`));
  }
  refuses("INSERT INTO dbo.T VALUES (1); DECLARE @r INT; SELECT @r = 1 FROM dbo.T; xp_regread", /xp_regread/);
});

test("four-part names are refused", () => {
  refuses("INSERT INTO srv.db.dbo.T VALUES (1)", /Four-part names/);
  refuses("INSERT INTO [srv].[db].[dbo].[T] VALUES (1)", /Four-part names/);
});

test("SELECT … INTO a permanent table is refused", () => {
  refuses("SELECT * INTO dbo.Copy FROM dbo.T; INSERT INTO dbo.T VALUES (1)", /SELECT … INTO a permanent table/);
  refuses("SELECT * INTO [dbo].[Copy] FROM dbo.T; INSERT INTO dbo.T VALUES (1)", /SELECT … INTO a permanent table/);
});

// --- transaction control: what keeps a preview from persisting -------------------

test("ROLLBACK outside the CATCH … THROW pattern is refused", () => {
  // The case that matters: ROLLBACK ends the preview's transaction, the INSERT after it autocommits.
  refuses("INSERT INTO dbo.T VALUES (1); ROLLBACK; INSERT INTO dbo.T VALUES (2);", /ROLLBACK is allowed only/);
  refuses("BEGIN TRY INSERT INTO dbo.T VALUES (1) END TRY BEGIN CATCH ROLLBACK; INSERT INTO dbo.Log VALUES (1); END CATCH", /ROLLBACK is allowed only/);
  refuses("BEGIN TRY INSERT INTO dbo.T VALUES (1) END TRY BEGIN CATCH ROLLBACK; RAISERROR('x', 16, 1); END CATCH", /ROLLBACK is allowed only/);
  refuses("BEGIN TRAN; INSERT INTO dbo.T VALUES (1); ROLLBACK TRAN sp1; COMMIT;", /ROLLBACK is allowed only|save/);
});

test("ROLLBACK; THROW in a CATCH nested inside another TRY is refused (THROW would not end the batch)", () => {
  refuses(
    `BEGIN TRY
       BEGIN TRY INSERT INTO dbo.T VALUES (1) END TRY
       BEGIN CATCH ROLLBACK; THROW; END CATCH
     END TRY
     BEGIN CATCH INSERT INTO dbo.Log VALUES (1); END CATCH`,
    /ROLLBACK is allowed only/
  );
});

test("SAVE TRANSACTION and distributed transactions are refused", () => {
  refuses("BEGIN TRAN; SAVE TRAN s1; INSERT INTO dbo.T VALUES (1); COMMIT;", /save/);
  refuses("BEGIN DISTRIBUTED TRANSACTION; INSERT INTO dbo.T VALUES (1); COMMIT;", /distributed/);
});

test("COMMIT is counted, and refused alongside a loop that could run it twice", () => {
  assert.equal(accepts("BEGIN TRAN; INSERT INTO dbo.T VALUES (1); COMMIT; BEGIN TRAN; UPDATE dbo.T SET a = 1 WHERE id = 1; COMMIT TRANSACTION;"), 2);
  refuses("BEGIN TRAN; WHILE 1 = 1 BEGIN INSERT INTO dbo.T VALUES (1); COMMIT; END", /may not use WHILE/);
  refuses("l: INSERT INTO dbo.T VALUES (1); COMMIT; GOTO l;", /must start with|goto/i);
  // A loop without COMMIT cannot end the outer transaction, so it is allowed.
  accepts("DECLARE @i INT = 0; WHILE @i < 3 BEGIN INSERT INTO dbo.T VALUES (@i); SET @i += 1; END");
});
