// Copyright (c) 2019, The TurtleCoin Developers
//
// Please see the included LICENSE file for more information.

'use strict'

const MySQL = require('mysql')

function DatabaseBackend (opts) {
  opts = opts || {}
  if (!(this instanceof DatabaseBackend)) return new DatabaseBackend(opts)
  this.host = opts.host || '127.0.0.1'
  this.port = opts.port || 3306
  this.username = opts.username || ''
  this.password = opts.password || ''
  this.database = opts.database || ''
  this.socketPath = opts.socketPath || false
  this.connectionLimit = opts.connectionLimit || 10

  this.db = MySQL.createPool({
    connectionLimit: this.connectionLimit,
    host: this.host,
    port: this.port,
    user: this.username,
    password: this.password,
    database: this.database,
    socketPath: this.socketPath
  })
}

DatabaseBackend.prototype.getPoolStats = function () {
  return new Promise((resolve, reject) => {
    const poolList = []

    function setPoolPropertyValue (id, property, value) {
      for (var i = 0; i < poolList.length; i++) {
        if (poolList[i].id === id) {
          poolList[i][property] = value
        }
      }
    }

    query(this.db, 'SELECT * FROM `pools` ORDER BY `name`', []).then((pools) => {
      pools.forEach(node => poolList.push(node))

      return query(this.db, [
        'SELECT `id`, ((SUM(`status`) / COUNT(*)) * 100) AS `availability` ',
        'FROM (SELECT `timestamp` AS `stamp` FROM `pool_polling` GROUP BY `timestamp` ORDER BY `timestamp` DESC LIMIT 20) AS `last` ',
        'LEFT JOIN `pool_polling` ON `pool_polling`.`timestamp` = `last`.`stamp` ',
        'GROUP BY `id`'
      ].join(''), [])
    }).then((rows) => {
      rows.forEach((row) => {
        setPoolPropertyValue(row.id, 'availability', row.availability)
      })

      return query(this.db, 'SELECT MAX(`timestamp`) AS `timestamp` FROM `pool_polling`', [])
    }).then((rows) => {
      if (rows.length === 0) throw new Error('No timestamp information in the database')
      return query(this.db, 'SELECT * FROM `pool_polling` WHERE `timestamp` = ?', [rows[0].timestamp || 0])
    }).then((rows) => {
      rows.forEach((row) => {
        setPoolPropertyValue(row.id, 'status', (row.status === 1))
        setPoolPropertyValue(row.id, 'height', row.height)
        setPoolPropertyValue(row.id, 'hashrate', row.hashrate)
        setPoolPropertyValue(row.id, 'miners', row.miners)
        setPoolPropertyValue(row.id, 'fee', row.fee)
        setPoolPropertyValue(row.id, 'minPayout', row.minPayout)
        setPoolPropertyValue(row.id, 'lastBlock', row.lastBlock)
        setPoolPropertyValue(row.id, 'donation', row.donation)
        setPoolPropertyValue(row.id, 'lastCheckTimestamp', row.timestamp)
      })

      return query(this.db, [
        'SELECT `id`, `status`, `timestamp` ',
        'FROM (SELECT `timestamp` AS `stamp` FROM `pool_polling` GROUP BY `timestamp` ORDER BY `timestamp` DESC LIMIT 20) AS `last` ',
        'LEFT JOIN `pool_polling` ON `pool_polling`.`timestamp` = `last`.`stamp` ',
        'ORDER BY `id` ASC, `timestamp` DESC'
      ].join(''), [])
    }).then((rows) => {
      const temp = {}

      rows.forEach((row) => {
        if (!temp[row.id]) temp[row.id] = []
        temp[row.id].push({ timestamp: row.timestamp, status: (row.status === 1) })
      })

      Object.keys(temp).forEach((key) => {
        setPoolPropertyValue(key, 'history', temp[key])
      })
    }).then(() => {
      return resolve(poolList)
    }).catch((err) => {
      return reject(err)
    })
  })
}

DatabaseBackend.prototype.savePools = function (pools) {
  const stmts = []

  pools.forEach((pool) => {
    stmts.push({
      query: [
        'REPLACE INTO `pools` ',
        '(`id`, `name`, `url`, `api`, `type`, `miningAddress`, ',
        '`mergedMining`, `mergedMiningIsParentChain`) VALUES ',
        '(?,?,?,?,?,?,?,?)'
      ].join(''),
      args: [
        pool.id,
        pool.name,
        pool.url,
        pool.api,
        pool.type,
        pool.miningAddress,
        pool.mergedMining,
        pool.mergedMiningIsParentChain
      ]
    })
  })

  return transaction(this.db, stmts)
}

DatabaseBackend.prototype.savePoolsPolling = function (timestamp, poolData) {
  const stmts = []

  poolData.forEach((data) => {
    if (data.error) return
    stmts.push({
      query: [
        'REPLACE INTO `pool_polling` ',
        '(`id`, `timestamp`, `height`, `hashrate`, `miners`, `fee`, ',
        '`minPayout`, `lastBlock`, `donation`, `status`) VALUES ',
        '(?,?,?,?,?,?,?,?,?,?)'
      ].join(''),
      args: [
        data.id,
        timestamp,
        data.height,
        data.hashrate,
        data.miners,
        data.fee,
        data.minPayout,
        data.lastBlock,
        data.donation,
        data.status
      ]
    })
  })

  return transaction(this.db, stmts)
}

DatabaseBackend.prototype.cleanPollingHistory = function (before) {
  return query(this.db, 'DELETE FROM `pool_polling` WHERE `timestamp` < ?', [before])
}

/* Executes the single query provided with the arguments provided
   against the provided database pool */
function query (db, query, args) {
  return new Promise((resolve, reject) => {
    db.query(query, args, (error, results, fields) => {
      if (error) return reject(error)
      return resolve(results, fields)
    })
  })
}

/* Executes a transaction (with rollback support) consisting of the
   queries provided in the querySet against the provided database pool */
function transaction (db, querySet) {
  function beginTransaction (conn) {
    return new Promise((resolve, reject) => {
      conn.beginTransaction((error) => {
        if (error) return reject(error)
        return resolve()
      })
    })
  }

  function commit (conn) {
    return new Promise((resolve, reject) => {
      conn.commit((error) => {
        if (error) return reject(error)
        return resolve()
      })
    })
  }

  function connection (db) {
    return new Promise((resolve, reject) => {
      db.getConnection((error, connection) => {
        if (error) return reject(error)
        return resolve(connection)
      })
    })
  }

  function q (conn, query, args) {
    return new Promise((resolve, reject) => {
      conn.query(query, args, (error, results, fields) => {
        if (error) return reject(error)
        return resolve(results, fields)
      })
    })
  }

  function rollback (conn) {
    return new Promise((resolve, reject) => {
      conn.rollback(() => {
        return resolve()
      })
    })
  }

  return new Promise((resolve, reject) => {
    var dbConnection = false
    var results = false

    connection(db).then((conn) => {
      dbConnection = conn
      return beginTransaction(dbConnection)
    }).then(() => {
      var promises = []

      querySet.forEach((stmt) => {
        promises.push(q(dbConnection, stmt.query, stmt.args))
      })

      return Promise.all(promises)
    }).then((querySetResults) => {
      results = querySetResults
      return commit(dbConnection)
    }).then(() => {
      dbConnection.release()
      return resolve(results)
    }).catch((error) => {
      if (dbConnection) {
        rollback(dbConnection).then(() => {
          dbConnection.release()
          return reject(error)
        }).catch((error) => {
          dbConnection.release()
          return reject(error)
        })
      } else {
        return reject(error)
      }
    })
  })
}

module.exports = DatabaseBackend
