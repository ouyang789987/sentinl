import _ from 'lodash';
import handleESError from '../lib/handle_es_error';
import getConfiguration from  '../lib/get_configuration';
import Joi from 'joi';
import dateMath from '@elastic/datemath';
import getElasticsearchClient from '../lib/get_elasticsearch_client';
import es from 'elasticsearch';
import Crypto from '../lib/classes/crypto';

/* ES Functions */
var getHandler = function (type, server, req, reply) {
  const config = getConfiguration(server);

  var timeInterval;
  // Use selected timefilter when available
  if (server.sentinlInterval) {
    timeInterval = server.sentinlInterval;
  } else {
    timeInterval = {
      from: 'now-15m',
      mode: 'quick',
      to: 'now'
    };
  }
  var qrange = {
    gte: dateMath.parse(timeInterval.from).valueOf(),
    lt: dateMath.parse(timeInterval.to, true).valueOf()
  };

  const { callWithRequest } = server.plugins.elasticsearch.getCluster('data');
  callWithRequest(req, 'search', {
    index: `${config.es.alarm_index}*`,
    sort: '@timestamp : asc',
    allowNoIndices: false,
    body: {
      size: config.sentinl.results ? config.sentinl.results : 50,
      query: {
        bool: {
          filter: [
            {
              term: { report: type === 'report' }
            },
            {
              range: { '@timestamp': qrange }
            }
          ]
        }
      }
    }
  })
  .then((res) => reply(res))
  .catch((err) => reply(handleESError(err)));
};

export default function routes(server) {

  const config = getConfiguration(server);
  const { callWithRequest } = server.plugins.elasticsearch.getCluster('data');

  // Current Time
  server.route({
    path: '/api/sentinl/time',
    method: 'GET',
    handler(req, reply) {
      reply({ time: new Date().toISOString() });
    }
  });

  // Local Alarms (session)
  server.route({
    path: '/api/sentinl/alarms',
    method: ['POST','GET'],
    handler(req, reply) {
      reply({ data: server.sentinlStore });
    }
  });

  // ES Alarms
  server.route({
    path: '/api/sentinl/list/alarms',
    method: ['POST', 'GET'],
    handler: function (req, reply) {
      getHandler('alarms', server, req, reply);
    }
  });

  server.route({
    path: '/api/sentinl/list/reports',
    method: ['POST', 'GET'],
    handler:  function (req, reply) {
      getHandler('report', server, req, reply);
    }
  });

  server.route({
    path: '/api/sentinl/config/auth_info',
    method: ['POST', 'GET'],
    handler: function (req, reply) {
      reply({
        enabled: config.settings.authentication.enabled,
        mode: config.settings.authentication.mode
      });
    }
  });

  // List Watchers
  server.route({
    path: '/api/sentinl/list',
    method: ['POST', 'GET'],
    handler: function (req, reply) {
      const body = {
        index: config.es.default_index,
        type: config.es.type,
        size: config.sentinl.results ? config.sentinl.results : 50,
        allowNoIndices: false
      };

      callWithRequest(req, 'search', body)
      .then((res) => {
        console.log(res);
        reply(res);
      })
      .catch((err) => reply(handleESError(err)));
    }
  });

  server.route({
    method: 'DELETE',
    path: '/api/sentinl/alarm/{index}/{type}/{id}',
    handler: function (req, reply) {
      // Check if alarm index and discard everything else
      if (!req.params.index.substr(0, config.es.alarm_index.length) === config.es.alarm_index) {
        server.log(['status', 'err', 'Sentinl'], 'Forbidden Delete Request! ' + req.params);
        return;
      }
      var body = {
        index: req.params.index,
        type: req.params.type,
        id: req.params.id
      };

      callWithRequest(req, 'delete', body)
      .then(() => callWithRequest(req, 'indices.refresh', {
        index: req.params.index
      }))
      .then((resp) => reply({ok: true, resp: resp}))
      .catch((err) => reply(handleESError(err)));
    }
  });

  // Get/Set Time Interval
  server.route({
    method: 'GET',
    path: '/api/sentinl/set/interval/{timefilter*}',
    handler: function (request, reply) {
      server.sentinlInterval = JSON.parse(request.params.timefilter);
      reply({ status: '200 OK' });
    }
  });
  server.route({
    method: 'GET',
    path: '/api/sentinl/get/interval',
    handler: function (request, reply) {
      reply(server.sentinlInterval);
    }
  });

  // Test
  server.route({
    method: 'GET',
    path: '/api/sentinl/test/{id}',
    handler: function (request, reply) {
      var client = server.plugins.elasticsearch.client;
      server.log(['status', 'info', 'Sentinl'], 'Testing ES connection with param: ' + request.params.id);
      client.ping({
        requestTimeout: 5000,
        // undocumented params are appended to the query string
        hello: 'elasticsearch'
      }, function (error) {
        if (error) {
          server.log(['warning', 'info', 'Sentinl'], 'ES Connectivity is down! ' + request.params.id);
          reply({ status: 'DOWN' });
        } else {
          server.log(['status', 'info', 'Sentinl'], 'ES Connectivity is up! ' + request.params.id);
          reply({ status: 'UP' });
        }
      });
    }
  });

  server.route({
    method: 'GET',
    path: '/api/sentinl/get/watcher/{id}',
    handler: function (request, reply) {
      server.log(['status', 'info', 'Sentinl'], 'Get Watcher with ID: ' + request.params.id);
      const body = {
        index: config.es.default_index,
        type: config.es.type,
        id: request.params.id
      };

      callWithRequest(request, 'get', body)
      .then((resp) => reply(resp))
      .catch((err) => {
        server.log(['debug', 'Sentinl'], err);
        reply(err);
      });
    }
  });

  server.route({
    method: 'POST',
    path: '/api/sentinl/watcher/{id}',
    handler: function (request, reply) {
      var watcher = request.payload;
      server.log(['status', 'info', 'Sentinl'], 'Saving Watcher with ID: ' + watcher._id);
      var body = {
        index: config.es.default_index,
        type: config.es.type,
        id: watcher._id,
        body: watcher._source
      };
      callWithRequest(request, 'index', body)
      .then(() => callWithRequest(request, 'indices.refresh', {
        index: config.es.default_index
      }))
      .then((resp) => reply({ok: true, resp: resp}))
      .catch((err) => reply(handleESError(err)));
    }
  });

  server.route({
    method: 'DELETE',
    path: '/api/sentinl/watcher/{id}',
    handler: function (request, reply) {
      var body = {
        index: config.es.default_index,
        type: config.es.type,
        id: request.params.id
      };
      callWithRequest(request, 'delete', body)
      .then(() => callWithRequest(request, 'indices.refresh', {
        index: config.es.default_index
      }))
      .then((resp) => reply({ok: true, resp: resp}))
      .catch((err) => reply(handleESError(err)));
    },
    config: {
      validate: {
        params: {
          id: Joi.string()
        }
      }
    }
  });

  server.route({
    method: 'GET',
    path: '/api/sentinl/validate/es',
    handler: function (request, reply) {
      var body = {
        index: config.es.default_index,
      };
      callWithRequest(request, 'fieldStats', body)
      .then(function (resp) {
        reply({
          ok: true,
          field: config.es.timefield,
          min: resp.index._all.fields[config.es.timefield].min_value,
          max: resp.index._all.fields[config.es.timefield].max_value
        });
      })
      .catch((err) => reply(handleESError(err)));
    }
  });

  server.route({
    method: 'POST',
    path: '/api/sentinl/get/user/{watcher_id}',
    handler: function (request, reply) {
      server.log(['status', 'info', 'Sentinl'], `Getting user for watcher ${request.params.watcher_id}`);

      const message = {
        index: config.settings.authentication.user_index,
        type: config.settings.authentication.user_type,
        id: request.params.watcher_id
      };

      callWithRequest(request, 'get', message)
      .then((resp) => reply(resp))
      .catch((err) => {
        server.log(['debug', 'Sentinl'], err);
        reply(err);
      });
    }
  });

  server.route({
    method: 'POST',
    path: '/api/sentinl/user/{watcher_id}/{username}/{password}',
    handler: function (request, reply) {
      server.log(['status', 'info', 'Sentinl'], `Saving user ${request.params.username} for watcher ${request.params.watcher_id}`);

      const crypto = new Crypto(config.settings.authentication.encryption);
      const message = {
        index: config.settings.authentication.user_index,
        type: config.settings.authentication.user_type,
        id: request.params.watcher_id,
        body: {
          username: request.params.username,
          sha: crypto.encrypt(request.params.password)
        }
      };

      callWithRequest(request, 'index', message)
      .then(() => callWithRequest(request, 'indices.refresh', {
        index: config.es.default_index
      }))
      .then((resp) => reply({ok: true, resp: resp}))
      .catch((err) => reply(handleESError(err)));
    }
  });

  server.route({
    method: 'POST',
    path: '/api/sentinl/save/one_script/{type}/{id}',
    handler: function (request, reply) {
      const script = request.payload;
      server.log(['status', 'info', 'Sentinl'], `Saving scripts with type: ${request.params.type}`);
      const body = {
        index: config.es.default_index,
        type: request.params.type,
        id: request.params.id,
        body: script
      };
      callWithRequest(request, 'index', body)
      .then(() => callWithRequest(request, 'indices.refresh', {
        index: config.es.default_index
      }))
      .then((resp) => reply({ok: true, resp: resp}))
      .catch((err) => reply(handleESError(err)));
    }
  });

  server.route({
    method: 'GET',
    path: '/api/sentinl/get/scripts/{type}',
    handler: function (request, reply) {
      server.log(['status', 'info', 'Sentinl'], `Get scripts with type: ${request.params.type}`);
      callWithRequest(request, 'search', {
        index: config.es.default_index,
        type: request.params.type,
        size: config.sentinl.scriptResults ? config.sentinl.scriptResults : 50,
        q: 'title:*'
      })
      .then((resp) => reply(resp))
      .catch((err) => {
        server.log(['debug', 'Sentinl'], err);
        reply(err);
      });
    }
  });

  server.route({
    method: 'DELETE',
    path: '/api/sentinl/remove/one_script/{type}/{id}',
    handler: function (request, reply) {
      const body = {
        index: config.es.default_index,
        type: request.params.type,
        id: request.params.id
      };
      server.log(['status', 'info', 'Sentinl'], `Delete script with type/id: ${request.params.type}/${request.params.id}`);
      callWithRequest(request, 'delete', body)
      .then(() => callWithRequest(request, 'indices.refresh', {
        index: config.es.default_index
      }))
      .then((resp) => reply({ok: true, resp: resp}))
      .catch((err) => reply(handleESError(err)));
    }
  });

};
