var merge = require('mrg'),
    Emitter = require('mttr'),
    safeApply = merge.safeApply;

var orm = require('./index'),
    Schema = require('./Schema'),
    CQLWriter = require('./CQLWriter');


module.exports = require('clss')('Model', function (def) {
	var Model = this;

	Emitter.create(this);

	def.init = function (data, exists) {
		if (this.constructor === Model) return createModel.apply(this, arguments);

		this.reset().mixin(data);

		if (typeof exists === 'function') this.save(exists);

		else this.exists = exists;

		if (!this.exists) this.constructor.emit('new instance', this);

		return this;
	};



	function createModel (name, info, proc) {
		var self = Model.clss(name, proc);

		self.schema = new Schema(info, self.name);
		self.cql = new CQLWriter(self.schema);

		Model.emit('new model', self);

		return self.prepare();
	}



	// Instance methods

	def.reset = function () {
		this.data = this.defaults();

		return this;
	};

	def.defaults = function () {
		var defaults = {},
		    schema = this.constructor.schema,
		    fields = schema.info.fields,
		    id = schema.givePrimaryKeys();

		schema.info.primaryKeys.forEach(function (key, i) {
			defaults[key] = id[i];
		});

		Object.keys(fields).forEach(function (name) {
			if (fields[name] && fields[name].default) {
				if (schema.info.primaryKeys.indexOf(name) === -1) {
					defaults[name] = fields[name].default;
				}
			}
		});

		return defaults;
	};

	def.mixin = function (data) {
		merge(this.data, data);

		return this;
	};


	def.set = function (name, value) {
		if (typeof name === 'object') return this.mixin(name);

		return this.data[name] = value;
	};

	def.get = function (name) {
		return this.data[name];
	};

	def.getId = function () {
		var id = this.constructor.schema.
			info.primaryKeys.map(this.get.bind(this));

		return id.length === 1 ? id[0] : id;
	};


	def.update = function (data, callback, options) {
		callback = callback || data;
		data = data === callback ? undefined : data;

		if (data) this.mixin(data);

		return this.constructor.updateById(this.data, this.getId(), callback, options);
	};

	def.destroy = function (callback, options) {
		return this.constructor.destroyById(this.getId(), callback, options);
	};

	def.save = function (callback, options) {
		if (this.exists) return this.update(null, callback, options);

		return this.constructor.insert(this.data, callback, options);
	};

	def.sync = function (callback, consistency) {
		var that = this;

		return this.constructor.selectById(this.getId(), function (err, data) {
			if (!err) that.mixin(data);

			safeApply(callback, arguments);
		}, consistency);
	};



	// Class methods

	this.prepare = function (callback) {
		var that = this;

		orm.events.on('ready', function (connection) {
			that.automigrate(function (err) {
				if (!err) that.useConnection(connection);

				safeApply(callback, arguments, that);
			}, connection);
		});

		return this;
	};


	this.useConnection = function (connection) {
		this.connection = connection;

		return this.forever('ready', connection);
	};


	this.execute = function (command, callback, that) {
		if (this.connection) return execute.call(this, this.connection);

		return this.on('ready', execute);

		function execute(connection) {
			connection.execute(command, callback, that || this);

			return this;
		}
	};

	this.batch = function (proc, callback, that, options) {
		if (this.connection) return batch.call(this, this.connection);

		return this.on('ready', batch);

		function batch(connection) {
			connection.batch(proc, callback, that || this, options);

			return this;
		}
	}


	this.find =
	this.all = function (filter, callback, consistency) {
		return this.execute(this.cql.selectAll(filter, consistency), function (err, rows) {
			safeApply(callback, [err, err ? undefined : this.fromDatabase(rows)]);
		});
	};

	this.select = function (expr, filter, callback, consistency) {
		return this.execute(this.cql.select(expr, filter, consistency), function (err, rows) {
			safeApply(callback, [err, err ? undefined : this.fromDatabase(rows)]);
		});
	};

	this.one = function (conds, order, offset, callback, consistency) {
		callback = callback || offset || order;
		offset = offset === callback ? undefined : offset;
		order = order === callback ? undefined : order;

		return this.execute(this.cql.selectOne(conds, order, offset, consistency), function (err, rows) {
			safeApply(callback, [err, err ? undefined : this.fromDatabase(rows)[0]]);
		});
	};

	this.byId = function (id, callback, consistency) {
		return this.execute(this.cql.selectById(id, consistency), function (err, rows) {
			safeApply(callback, [err, err ? undefined : this.fromDatabase(rows)[0]]);
		});
	};


	this.fromDatabase = function (rows) {
		var schema = this.schema;

		if (!rows) return [];

		return rows.map(function (row) {
			if (!row) return null;

			var data = {};

			row.forEach(function (name, value, ts, ttl) {
				data[name] = schema.fromDatabase(value, name);
			});

			return new Model(data, true);
		});
	};


	this.count = function (conds, limit, offset, callback, consistency) {
		callback = callback || offset || limit;
		offset = offset === callback ? undefined : offset;
		limit = limit === callback ? undefined : limit;

		return this.execute(this.cql.count(conds, limit, offset, consistency), callback);
	};


	this.insert = function (data, callback, options)  {
		return this.execute(this.cql.insert(data, options), callback);
	}


	this.update = function (data, conds, callback, options) {
		return this.execute(this.cql.update(data, conds, options), callback);
	};

	this.updateById = function (data, id, callback, options) {
		return this.execute(this.cql.updateById(data, id, options), callback);
	};


	this.destroy = function (columns, conds, callback, options) {
		return this.execute(this.cql.destroy(columns, conds, options), callback);
	};

	this.destroyAll = function (conds, callback, options) {
		return this.execute(this.cql.destroyAll(conds, options), callback);
	};

	this.destroyById = function (id, callback, options) {
		return this.execute(this.cql.destroyById(id, options), callback);
	};


	this.empty =
	this.truncate = function (callback) {
		return this.execute(this.cql.truncate(), callback);
	};


	this.alterTable = function (changes, callback) {
		return this.execute(this.cql.alterTable(changes), callback);
	};


	this.automigrate = function (callback, connection) {
		connection = connection || this.connection;

		var that = this,
		    name = this.cql.tableName(),
		    keyspace = connection.keyspace;

		return keyspace.get(name, function (err, columnFamily) {
			if (err && err.name !== 'HelenusNotFoundError') {
				return safeApply(callback, [err], that);
			}

			if (columnFamily) {
				// TODO: check schema for changes and alter table
				safeApply(callback, [], that);

			} else {
				if (connection) procedure(connection);

				else that.on('ready', procedure);
			}
		});

		function procedure (connection) {
			connection.execute(that.cql.createTable(), callback);/*function (err) {
				if (err) return safeApply(callback, [err], that);

				connection.batch(function () {
					that.schema.getIndexes().forEach(function (name) {
						connection.execute(that.cql.createIndex(name))
					});
				}, callback, that);
			});*/
		}
	};



	this.hasOne = function (model, options) {
		// TODO:
	};

	this.hasMany = function (model, options) {
		// TODO:
	};

	this.belongsTo = function (model, options) {
		// TODO:
	};


	// TODO: validations
});