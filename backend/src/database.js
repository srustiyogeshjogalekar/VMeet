const fs = require("node:fs");
const path = require("node:path");
const initSqlJs = require("sql.js");

async function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const SQL = await initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`),
  });
  const database = fs.existsSync(databasePath)
    ? new SQL.Database(fs.readFileSync(databasePath))
    : new SQL.Database();

  function persist() {
    const temporaryPath = `${databasePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, Buffer.from(database.export()));
    fs.renameSync(temporaryPath, databasePath);
  }

  return {
    exec(sql) {
      database.run(sql);
      persist();
    },
    prepare(sql) {
      return {
        run(...parameters) {
          database.run(sql, parameters);
          const changes = database.getRowsModified();
          persist();
          return { changes };
        },
        get(...parameters) {
          const statement = database.prepare(sql);
          try {
            statement.bind(parameters);
            return statement.step() ? statement.getAsObject() : undefined;
          } finally {
            statement.free();
          }
        },
        all(...parameters) {
          const statement = database.prepare(sql);
          const rows = [];
          try {
            statement.bind(parameters);
            while (statement.step()) rows.push(statement.getAsObject());
            return rows;
          } finally {
            statement.free();
          }
        },
      };
    },
    close() {
      persist();
      database.close();
    },
  };
}

module.exports = { openDatabase };
