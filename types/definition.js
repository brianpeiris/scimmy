import {Attribute} from "./attribute.js";
import {Filter} from "./filter.js";

/**
 * SCIM Schema Definition
 */
export class SchemaDefinition {
    /**
     * Constructs an instance of a full SCIM schema definition
     * @param {String} name - friendly name of the SCIM schema
     * @param {String} id - URN namespace of the SCIM schema
     * @param {String} [description=""] - a human-readable description of the schema
     * @param {Attribute[]} [attributes=[]] - attributes that make up the schema
     */
    constructor(name = "", id = "", description = "", attributes = []) {
        // Store the schema name, ID, and description
        this.name = name;
        this.id = id;
        this.description = description;
        
        // Add common attributes used by all schemas, then add the schema-specific attributes
        this.attributes = [
            new Attribute("reference", "schemas", {shadow: true, multiValued: true, referenceTypes: ["uri"]}),
            new Attribute("string", "id", {shadow: true, direction: "out", returned: "always", required: true, mutable: false, caseExact: true, uniqueness: "global"}),
            new Attribute("string", "externalId", {shadow: true, direction: "in", caseExact: true}),
            new Attribute("complex", "meta", {shadow: true, required: true, mutable: false}, [
                new Attribute("string", "resourceType", {required: true, mutable: false, caseExact: true}),
                new Attribute("dateTime", "created", {direction: "out", mutable: false}),
                new Attribute("dateTime", "lastModified", {direction: "out", mutable: false}),
                new Attribute("string", "location", {direction: "out", mutable: false}),
                new Attribute("string", "version", {direction: "out", mutable: false})
            ]),
            // Only include valid Attribute instances
            ...attributes.filter(attr => attr instanceof Attribute)
        ];
    }
    
    /**
     * Get the SCIM schema definition for consumption by clients
     * @param {String} [basepath=""] - the base path for the schema's meta.location property
     * @returns {Object} the schema definition for consumption by clients
     */
    describe(basepath = "") {
        return {
            schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
            id: this.id, name: this.name, description: this.description,
            attributes: this.attributes.filter(a => (a instanceof Attribute && !a.config.shadow)),
            meta: {resourceType: "Schema", location: `${basepath}/${this.id}`}
        };
    }
    
    /**
     * Find an attribute or extension instance belonging to the schema definition by its name
     * @param {String} name - the name of the attribute to look for (namespaced or direct)
     * @return {Attribute|SchemaDefinition} the Attribute or SchemaDefinition instance with matching name
     */
    attribute(name) {
        if (name.startsWith("urn:")) {
            // Handle namespaced attributes by looking for a matching extension
            let extension = (name.startsWith(this.id) ? this : this.attributes
                    .find(a => a instanceof SchemaDefinition && name.startsWith(a.id))),
                // Get the actual attribute name minus extension ID
                attribute = name.replace(extension.id, "");
            
            // If the actual name is empty, return the extension, otherwise search the extension
            return (!attribute.length ? extension : extension.attribute(attribute));
        } else {
            // Break name into path parts in case of search for sub-attributes
            let path = name.split("."),
                // Find the first attribute in the path
                target = path.shift(),
                attribute = this.attributes.find(a => a instanceof Attribute && a.name === target),
                spent = [target];
            
            // If nothing was found, the attribute isn't declared by the schema definition
            if (attribute === undefined)
                throw new TypeError(`Schema definition '${this.id}' does not declare attribute '${target}'`);
            
            // Evaluate the rest of the path
            while (path.length > 0) {
                // If the attribute isn't complex, it can't declare sub-attributes
                if (attribute.type !== "complex")
                    throw new TypeError(`Attribute '${spent.join(".")}' of schema '${this.id}' is not of type 'complex' and does not define any subAttributes`);
                
                // Find the next attribute in the path
                target = path.shift();
                attribute = attribute.subAttributes.find(a => a instanceof Attribute && a.name === target);
                
                // If nothing found, the attribute doesn't declare the target as a sub-attribute
                if (attribute === undefined)
                    throw new TypeError(`Attribute '${spent.join(".")}' of schema '${this.id}' does not declare subAttribute '${target}'`);
                
                // Add the found attribute to the spent path
                spent.push(target);
            }
    
            return attribute;
        }
    }
    
    /**
     * Extend a schema definition instance by mixing in other schemas or attributes
     * @param {Array[Schema|Attribute>]} extensions[] - the schema extensions or collection of attributes to register
     * @param {Boolean} [required=false] - if the extension is a schema, whether or not the extension is required
     */
    extend(extensions = [], required) {
        // Go through all extensions to register
        for (let extension of (Array.isArray(extensions) ? extensions : [extensions])) {
            // If the extension is an attribute, add it to the schema definition instance
            if (extension instanceof Attribute) this.attributes.push(extension);
            // If the extension is a schema definition, add it to the schema definition instance
            else if (extension instanceof SchemaDefinition) {
                // Proxy the schema definition for use in this schema definition
                this.attributes.push(Object.create(extension, {
                    // Store whether the extension is required
                    required: {value: required ?? extension.required ?? false},
                    // When queried, only return attributes that directly belong to the schema definition
                    attributes: {get: () => extension.attributes.filter(a => a instanceof Attribute && !a?.config?.shadow)}
                }));
                
                // Go through the schema extension definition and directly register any nested schema definitions
                let surplusSchemas = extension.attributes.filter(e => e instanceof SchemaDefinition);
                for (let definition of surplusSchemas) this.extend(definition);
            }
            // If something other than a schema definition or attribute is supplied, bail out!
            else throw new TypeError("Expected 'definition' to be a collection of SchemaDefinition or Attribute instances");
        }
    }
    
    /**
     * Coerce a given value by making sure it conforms to all schema attributes' characteristics
     * @param {Object} data - value to coerce and confirm conformity of properties to schema attributes' characteristics
     * @param {String} [direction="both"] - whether to check for inbound, outbound, or bidirectional attributes
     * @param {String} [basepath] - the URI representing the resource type's location
     * @param {Filter} [filters] - the attribute filters to apply to the coerced value
     * @returns {Object} the coerced value, conforming to all schema attributes' characteristics
     */
    coerce(data, direction = "both", basepath, filters) {
        // Make sure there is data to coerce...
        if (data === undefined) throw new Error("No data to coerce");
        
        let filter = (filters ?? []).slice(0).shift(),
            target = {},
            // Compile a list of schema IDs to include in the resource
            schemas = [...new Set([
                this.id,
                ...(this.attributes.filter(a => a instanceof SchemaDefinition)
                    .map(s => s.id).filter(id => !!data[id])),
                ...(Array.isArray(data.schemas) ? data.schemas : [])
            ])],
            // Add schema IDs, and schema's name as resource type to meta attribute
            source = {
                ...data, schemas: schemas, meta: {
                    ...(data?.meta ?? {}), resourceType: this.name,
                    ...(typeof basepath === "string" ? {location: `${basepath}/${data.id}`} : {})
                }
            };
        
        // Go through all attributes and coerce them
        for (let attribute of this.attributes) {
            if (attribute instanceof Attribute) {
                let {name} = attribute,
                    // Evaluate the coerced value
                    value = attribute.coerce(source[name] ?? source[`${name[0].toUpperCase()}${name.slice(1)}`], direction);
                
                // If it's defined, add it to the target
                if (value !== undefined) target[name] = value;
            } else if (attribute instanceof SchemaDefinition) {
                // TODO: namespaced schema extension attributes in source data
                let {id: name, required} = attribute;
                
                // Attempt to coerce the schema extension
                if (!!required && !source[name]) throw new TypeError(`Missing values for required schema extension '${name}'`);
                else target[name] = attribute.coerce(source[name], direction, basepath, filter);
            }
        }
        
        return SchemaDefinition.#filter(target, {...filter}, this.attributes);
    }
    
    /**
     * Filter out desired or undesired attributes from a coerced schema value
     * @param {Object|Object[]} [data] - the data to filter attributes from
     * @param {Object} [filter] - the filter to apply to the coerced value
     * @param {Attribute[]} [attributes] - set of attributes to match against
     * @returns {Object} the coerced value with desired or undesired attributes filtered out
     */
    static #filter(data = {}, filter, attributes) {
        // If there's no filter, just return the data
        if (filter === undefined) return data;
        // If the data is a set, only get values that match the filter
        else if (Array.isArray(data)) return new Filter([filter]).match(data);
        // Otherwise, filter the data!
        else {
            // Check for any negative filters
            for (let key in {...filter}) {
                let {config: {returned} = {}} = attributes.find(a => a.name === key) ?? {};
                
                if (returned !== "always" && Array.isArray(filter[key]) && filter[key][0] === "np") {
                    // Remove the property from the result, and remove the spent filter
                    delete data[key];
                    delete filter[key];
                }
            }
            
            // Check to see if there's any filters left
            if (!Object.keys(filter).length) return data;
            else {
                // Prepare resultant value storage
                let target = {}
                
                // Go through every value in the data and filter attributes
                for (let key in data) {
                    // Get the matching attribute definition and some relevant config values
                    let attribute = attributes.find(a => a.name === key) ?? {},
                        {type, config: {returned, multiValued} = {}, subAttributes} = attribute;
                    
                    // If the attribute is always returned, add it to the result
                    if (returned === "always") target[key] = data[key];
                    // Otherwise, if the attribute ~can~ be returned, process it
                    else if (returned === true) {
                        // If the filter is simply based on presence, assign the result
                        if (Array.isArray(filter[key]) && filter[key][0] === "pr")
                            target[key] = data[key];
                        // Otherwise if the filter is defined and the attribute is complex, evaluate it
                        else if (key in filter && type === "complex") {
                            let value = SchemaDefinition.#filter(data[key], filter[key], multiValued ? [] : subAttributes);
                            
                            // Only set the value if it isn't empty
                            if ((!multiValued && value !== undefined) || (Array.isArray(value) && value.length))
                                target[key] = value;
                        }
                    }
                }
                
                return target;
            }
        }
    }
}