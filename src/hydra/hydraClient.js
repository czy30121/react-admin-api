import {
  CREATE,
  DELETE,
  GET_LIST,
  GET_MANY,
  GET_MANY_REFERENCE,
  GET_ONE,
  UPDATE,
} from 'admin-on-rest';
import isPlainObject from 'lodash.isplainobject';
import qs from 'qs';
import fetchHydra from './fetchHydra';

class AORDocument {
  constructor(obj) {
    Object.assign(this, obj, {
      originId: obj.id,
      id: obj['@id'],
    });
  }

  /**
   * @return {string}
   */
  toString() {
    return `[object ${this.id}]`;
  }
}

/**
 * Local cache containing embedded documents.
 * It will be used to prevent useless extra HTTP query if the relation is displayed.
 *
 * @type {Map}
 */
const aorDocumentsCache = new Map();

/**
 * Transforms a JSON-LD document to an admin-on-rest compatible document.
 *
 * @param {Object} document
 * @param {bool} clone
 *
 * @return {AORDocument}
 */
export const transformJsonLdDocumentToAORDocument = (
  document,
  clone = true,
  addToCache = true,
) => {
  if (clone) {
    // deep clone documents
    document = JSON.parse(JSON.stringify(document));
  }

  // The main document is a JSON-LD document, convert it and store it in the cache
  if (document['@id']) {
    document = new AORDocument(document);
  }

  // Replace embedded objects by their IRIs, and store the object itself in the cache to reuse without issuing new HTTP requests.
  Object.keys(document).forEach(key => {
    // to-one
    if (isPlainObject(document[key]) && document[key]['@id']) {
      if (addToCache) {
        aorDocumentsCache[
          document[key]['@id']
        ] = transformJsonLdDocumentToAORDocument(document[key], false, false);
      }
      document[key] = document[key]['@id'];

      return;
    }

    // to-many
    if (
      Array.isArray(document[key]) &&
      document[key].length &&
      isPlainObject(document[key][0]) &&
      document[key][0]['@id']
    ) {
      document[key] = document[key].map(obj => {
        if (addToCache) {
          aorDocumentsCache[obj['@id']] = transformJsonLdDocumentToAORDocument(
            obj,
            false,
            false,
          );
        }

        return obj['@id'];
      });
    }
  });

  return document;
};

/**
 * Maps admin-on-rest queries to a Hydra powered REST API
 *
 * @see http://www.hydra-cg.com/
 *
 * @example
 * CREATE   => POST http://my.api.url/posts/123
 * DELETE   => DELETE http://my.api.url/posts/123
 * GET_LIST => GET http://my.api.url/posts
 * GET_MANY => GET http://my.api.url/posts/123, GET http://my.api.url/posts/456, GET http://my.api.url/posts/789
 * GET_ONE  => GET http://my.api.url/posts/123
 * UPDATE   => PUT http://my.api.url/posts/123
 */
export default ({entrypoint, resources = []}, httpClient = fetchHydra) => {
  /**
   * @param {string} resource
   * @param {Object} data
   *
   * @returns {Promise}
   */
  const convertAORDataToHydraData = (resource, data = {}) => {
    resource = resources.find(({name}) => resource === name);
    if (undefined === resource) {
      return Promise.resolve(data);
    }

    const fieldData = [];
    resource.fields.forEach(({name, normalizeData}) => {
      if (!(name in data) || undefined === normalizeData) {
        return;
      }

      fieldData[name] = normalizeData(data[name]);
    });

    const fieldDataKeys = Object.keys(fieldData);
    const fieldDataValues = Object.values(fieldData);

    return Promise.all(fieldDataValues).then(fieldData => {
      const object = {};
      for (let i = 0; i < fieldDataKeys.length; i++) {
        object[fieldDataKeys[i]] = fieldData[i];
      }

      return {...data, ...object};
    });
  };

  /**
   * @param {string} type
   * @param {string} resource
   * @param {Object} params
   *
   * @returns {Object}
   */
  const convertAORRequestToHydraRequest = (type, resource, params) => {
    switch (type) {
      case CREATE:
        return convertAORDataToHydraData(resource, params.data).then(data => ({
          options: {
            body: JSON.stringify(data),
            method: 'POST',
          },
          url: `${entrypoint}/${resource}`,
        }));

      case DELETE:
        return Promise.resolve({
          options: {
            method: 'DELETE',
          },
          url: entrypoint + params.id,
        });

      case GET_LIST: {
        const {
          pagination: {page},
          sort: {field, order},
        } = params;

        return Promise.resolve({
          options: {},
          url: `${entrypoint}/${resource}?${qs.stringify({
            ...params.filter,
            order: {
              [field]: order,
            },
            page,
          })}`,
        });
      }

      case GET_MANY_REFERENCE:
        return Promise.resolve({
          options: {},
          url: `${entrypoint}/${resource}?${qs.stringify({
            [params.target]: params.id,
          })}`,
        });

      case GET_ONE:
        return Promise.resolve({
          options: {},
          url: entrypoint + params.id,
        });

      case UPDATE:
        return convertAORDataToHydraData(resource, params.data).then(data => ({
          options: {
            body: JSON.stringify(data),
            method: 'PUT',
          },
          url: entrypoint + params.id,
        }));

      default:
        throw new Error(`Unsupported fetch action type ${type}`);
    }
  };

  /**
   * @param {string} resource
   * @param {Object} data
   *
   * @returns {Promise}
   */
  const convertHydraDataToAORData = (resource, data = {}) => {
    resource = resources.find(({name}) => resource === name);
    if (undefined === resource) {
      return Promise.resolve(data);
    }

    const fieldData = {};
    resource.fields.forEach(({name, denormalizeData}) => {
      if (!(name in data) || undefined === denormalizeData) {
        return;
      }

      fieldData[name] = denormalizeData(data[name]);
    });

    const fieldDataKeys = Object.keys(fieldData);
    const fieldDataValues = Object.values(fieldData);

    return Promise.all(fieldDataValues).then(fieldData => {
      const object = {};
      for (let i = 0; i < fieldDataKeys.length; i++) {
        object[fieldDataKeys[i]] = fieldData[i];
      }

      return {...data, ...object};
    });
  };

  /**
   * @param {Object} response
   * @param {string} resource
   * @param {string} type
   *
   * @returns {Promise}
   */
  const convertHydraResponseToAORResponse = (type, resource, response) => {
    switch (type) {
      case GET_LIST:
      case GET_MANY_REFERENCE:
        // TODO: support other prefixes than "hydra:"
        return Promise.resolve(
          response.json['hydra:member'].map(
            transformJsonLdDocumentToAORDocument,
          ),
        )
          .then(data =>
            Promise.all(
              data.map(data => convertHydraDataToAORData(resource, data)),
            ),
          )
          .then(data => ({data, total: response.json['hydra:totalItems']}));

      default:
        return Promise.resolve(
          transformJsonLdDocumentToAORDocument(response.json),
        )
          .then(data => convertHydraDataToAORData(resource, data))
          .then(data => ({data}));
    }
  };

  /**
   * @param {string} type
   * @param {string} resource
   * @param {Object} params
   *
   * @returns {Promise}
   */
  const fetchApi = (type, resource, params) => {
    // Hydra doesn't handle WHERE IN requests, so we fallback to calling GET_ONE n times instead
    if (GET_MANY === type) {
      return Promise.all(
        params.ids.map(
          id =>
            aorDocumentsCache[id]
              ? Promise.resolve({data: aorDocumentsCache[id]})
              : fetchApi(GET_ONE, resource, {id}),
        ),
      ).then(responses => ({data: responses.map(({data}) => data)}));
    }

    return convertAORRequestToHydraRequest(type, resource, params)
      .then(({url, options}) => httpClient(url, options))
      .then(response =>
        convertHydraResponseToAORResponse(type, resource, response),
      );
  };

  return fetchApi;
};
