module TsdPlugin {
    const CLS_DESC_PLACEHOLDER = "%TYPENAME%";

    interface IGeneratorStats {
        typedefs: {
            user: number;
            gen: number;
        },
        moduleMembers: number;
        ifaces: number;
        classes: number;
    }

    /**
     * The class that does all the grunt work
     */
    export class TsdGenerator {
        private moduleMembers: Dictionary<TSMember[]>;
        private globalMembers: TSMember[];
        private moduleDoclets: Dictionary<IDoclet>;
        private classes: Dictionary<TSClass>;
        private typedefs: Dictionary<TSTypedef>;
        private trackedDoclets: Dictionary<IDoclet>;
        private userTypeAliases: TSUserTypeAlias[];
        private userInterfaces: TSUserInterface[];
        
        private config: ITypeScriptPluginConfiguration;
        private stats: IGeneratorStats;
        constructor(config: any) {
            this.config = {
                rootModuleName: (config.rootModuleName || "generated"),
                outDir: (config.outDir || "."),
                typeReplacements: (config.typeReplacements || {}),
                defaultCtorDesc: (config.defaultCtorDesc || ("Constructor for " + CLS_DESC_PLACEHOLDER)),
                fillUndocumentedDoclets: !!config.fillUndocumentedDoclets,
                outputDocletDefs: !!config.outputDocletDefs,
                publicAnnotation: (config.publicAnnotation || null),
                defaultReturnType: (config.defaultReturnType || "any"),
                aliases: {
                    global: ((config.aliases || {}).global || {}),
                    module: ((config.aliases || {}).module || {})
                },
                interfaces: {
                    global: ((config.interfaces || {}).global || {}),
                    module: ((config.interfaces || {}).module || {})
                },
                ignoreTypes: {},
                makePublic: (config.makePublic || []),
                headerFile: config.headerFile,
                footerFile: config.footerFile,
                memberReplacements: (config.memberReplacements || {}),
                doNotDeclareTopLevelElements: !!config.doNotDeclareTopLevelElements,
                ignoreModules: (config.ignoreModules || []),
                doNotSkipUndocumentedDoclets: !!config.doNotSkipUndocumentedDoclets,
                initialIndentation: (config.initialIndentation || 0),
                globalModuleAliases: (config.globalModuleAliases || [])
            }
            var ignoreJsDocTypes = (config.ignore || []);
            for (let ignoreType of ignoreJsDocTypes) {
                this.config.ignoreTypes[ignoreType] = ignoreType;
            }
            this.classes = {};
            this.typedefs = {};
            this.moduleDoclets = {};
            this.moduleMembers = {};
            this.trackedDoclets = {};
            this.globalMembers = [];
            this.userInterfaces = [];
            this.userTypeAliases = [];
            this.stats = {
                typedefs: {
                    user: 0,
                    gen: 0
                },
                moduleMembers: 0,
                ifaces: 0,
                classes: 0
            };
            //Register standard TS type replacements
            this.config.typeReplacements["*"] = "any";
            this.config.typeReplacements["?"] = "any";
            this.config.typeReplacements["Object"] = "any";
            this.config.typeReplacements["function"] = "Function";
        }
        private ignoreThisType(fullname: string): boolean {
            if (this.config.ignoreTypes[fullname])
                return true;
            else
                return false;
        }
        
        private ensureClassDef(name: string, factory?: () => TSClass): TSClass {
            if (!this.classes[name]) {
                if (factory != null) {
                    var cls = factory();
                    this.classes[name] = cls;
                    return cls;
                } else {
                    return null;
                }
            } else {
                return this.classes[name];
            }
        }
        private ensureTypedef(name: string, factory?: () => TSTypedef): TSTypedef {
            if (!this.typedefs[name]) {
                if (factory != null) {
                    var tdf = factory();
                    this.typedefs[name] = tdf;
                    return tdf;
                } else {
                    return null;
                }
            } else {
                return this.typedefs[name];
            }
        }
        
        private parseClassesAndTypedefs(doclets: IDoclet[]): void {
            for (var doclet of doclets) {
                //On ignore list
                if (this.ignoreThisType(doclet.longname))
                    continue;
                //Undocumented and we're ignoring them
                if (doclet.undocumented === true && this.config.doNotSkipUndocumentedDoclets === false)
                    continue;

                //TypeScript definition covers a module's *public* API surface, so
                //skip private classes
                let isPublic = !(TypeUtil.isPrivateDoclet(doclet, this.config));
                let parentModName = null;
                if (doclet.longname.indexOf("module:") >= 0) {
                    //Assuming that anything annotated "module:" will have a "." to denote end of module and start of class name
                    let modLen = "module:".length;
                    let dotIdx = doclet.longname.indexOf(".");
                    if (dotIdx < 0)
                        dotIdx = doclet.longname.length;
                    parentModName = doclet.longname.substring(modLen, dotIdx);
                } else if (doclet.memberof) {
                    parentModName = doclet.memberof;
                }
                let makeGlobal = this.config.globalModuleAliases.indexOf(parentModName) >= 0;
                if (doclet.kind == DocletKind.Class) {
                    //Key class definition on longname
                    let cls = this.ensureClassDef(doclet.longname, () => new TSClass(doclet));
                    cls.setIsPublic(isPublic);
                    if (parentModName != null)
                        cls.setParentModule(parentModName);
                    if (doclet.params != null)
                        cls.ctor = new TSConstructor(doclet);
                    this.trackedDoclets[doclet.longname] = doclet;
                } else if (doclet.kind == DocletKind.Typedef) {
                    if (TsdGenerator.isCallbackType(doclet)) {
                        if (parentModName != null && this.moduleMembers[parentModName] == null)
                            this.moduleMembers[parentModName] = [];
                        let method = new TSMethod(doclet)
                        method.setIsModule(true);
                        method.setIsTypedef(true);
                        if (parentModName != null && !makeGlobal)
                            this.moduleMembers[parentModName].push(method);
                        else if (makeGlobal)
                            this.globalMembers.push(method);
                    } else {
                        let tdf = null;
                        if (makeGlobal)
                            tdf = new TSTypedef(doclet);
                        else
                            tdf = this.ensureTypedef(doclet.longname, () => new TSTypedef(doclet));
                        tdf.setIsPublic(isPublic);
                        if (parentModName != null && !makeGlobal)
                            tdf.setParentModule(parentModName);
                        else if (makeGlobal)
                            this.globalMembers.push(tdf);
                    }
                    this.trackedDoclets[doclet.longname] = doclet;
                } else if (doclet.kind == DocletKind.Function) {
                    let parentModule = doclet.memberof;
                    if (parentModule == null) {
                        let method = new TSMethod(doclet);
                        method.setIsModule(true);
                        method.setIsPublic(isPublic);
                        method.setIsTypedef(false);
                        this.globalMembers.push(method);
                        this.trackedDoclets[doclet.longname] = doclet;
                    }
                } else if (TypeUtil.isEnumDoclet(doclet)) {
                    let tdf = null;
                    if (makeGlobal)
                        tdf = new TSTypedef(doclet);
                    else
                        tdf = this.ensureTypedef(doclet.longname, () => new TSTypedef(doclet));
                    tdf.setIsPublic(isPublic);
                    if (parentModName != null && !makeGlobal)
                        tdf.setParentModule(parentModName);
                    else if (makeGlobal)
                        this.globalMembers.push(tdf);
                    this.trackedDoclets[doclet.longname] = doclet;
                }
            }
        }
        private parseModules(doclets: IDoclet[]): void {
            for (var doclet of doclets) {
                //Already covered in 1st pass
                if (this.trackedDoclets[doclet.longname] != null)
                    continue;
                //On ignore list
                if (this.ignoreThisType(doclet.longname))
                    continue;
                //Undocumented and we're ignoring them
                if (doclet.undocumented === true && this.config.doNotSkipUndocumentedDoclets === false)
                    continue;
                
                if (doclet.kind == DocletKind.Module) {
                    this.moduleDoclets[doclet.name] = doclet;
                    this.trackedDoclets[doclet.longname] = doclet;
                }
            }
        }
        private static isCallbackType(doclet: IDoclet): boolean {
            return doclet.kind == DocletKind.Typedef && 
                   doclet.type != null &&
                   doclet.type.names != null &&
                   doclet.type.names.indexOf("function") >= 0 &&
                   //This is to check that the function type was documented using @callback instead of @typedef
                   (doclet.comment || "").indexOf("@callback") >= 0;
        }
        private processTypeMembers(doclets: IDoclet[]): void {
            for (var doclet of doclets) {
                //Already covered in 1st pass
                if (this.trackedDoclets[doclet.longname] != null)
                    continue;
                //On the ignore list
                if (this.ignoreThisType(doclet.longname))
                    continue;
                //Undocumented and we're ignoring them
                if (doclet.undocumented === true && this.config.doNotSkipUndocumentedDoclets === false)
                    continue;

                var isPublic = !TypeUtil.isPrivateDoclet(doclet, this.config);

                //We've keyed class definition on longname, so memberof should
                //point to it
                var cls: TSComposable = this.ensureClassDef(doclet.memberof);
                var isTypedef = false;
                var isClass = true;
                if (!cls) {
                    isClass = false;
                    //Failing that it would've been registered as a typedef
                    cls = this.ensureTypedef(doclet.memberof);
                    if (!cls) {
                        //Bail on this iteration here if not public
                        if (!isPublic)
                            continue;

                        //Before we bail, let's assume this is a module level member and
                        //see if it's the right doclet kind
                        let parentModule = doclet.memberof;
                        if (parentModule == null)
                            continue;

                        parentModule = ModuleUtils.cleanModuleName(parentModule);
                        
                        //HACK-ish: If we found an enum, that this is a member of, skip it if it already exists
                        let parentDoclet = this.trackedDoclets[doclet.memberof];
                        if (parentDoclet != null && TypeUtil.isEnumDoclet(parentDoclet)) {
                            let matches = (parentDoclet.properties || []).filter(prop => prop.name == doclet.name);
                            if (matches.length > 0)
                                continue;
                        }

                        if (doclet.kind == DocletKind.Function) {
                            if (this.moduleMembers[parentModule] == null)
                                this.moduleMembers[parentModule] = [];
                            let method = new TSMethod(doclet)
                            method.setIsModule(true);
                            this.moduleMembers[parentModule].push(method);
                        } else if (doclet.kind == DocletKind.Constant || doclet.kind == DocletKind.Value || (doclet.kind == DocletKind.Member && doclet.params == null)) {
                            if (this.moduleMembers[parentModule] == null)
                                this.moduleMembers[parentModule] = [];
                            let prop = new TSProperty(doclet, false);
                            prop.setIsModule(true);
                            this.moduleMembers[parentModule].push(prop);
                        }
                        continue;
                    } else {
                        isTypedef = true;
                    }
                }
                
                if (doclet.kind == DocletKind.Function) {
                    var method = new TSMethod(doclet);
                    method.setIsPublic(isPublic);
                    cls.addMember(method);
                } else if (doclet.kind == DocletKind.Value || (doclet.kind == DocletKind.Member && doclet.params == null)) {
                    var prop = new TSProperty(doclet, isTypedef);
                    prop.setIsPublic(isPublic);
                    cls.addMember(prop);
                }
            }
        }
        private processUserDefinedTypes(): void {
            //Output user-injected type aliases
            //global
            for (var typeAlias in this.config.aliases.global) {
                this.userTypeAliases.push(new TSUserTypeAlias(null, typeAlias, this.config.aliases.global[typeAlias]));
            }
            //module
            for (var moduleName in this.config.aliases.module) {
                for (var typeAlias in this.config.aliases.module[moduleName]) {
                    this.userTypeAliases.push(new TSUserTypeAlias(moduleName, typeAlias, this.config.aliases.module[moduleName][typeAlias]));
                }
            }
            //Output user-injected interfaces
            //global
            for (var typeName in this.config.interfaces.global) {
                var iface = this.config.interfaces.global[typeName];
                this.userInterfaces.push(new TSUserInterface(null, typeName, iface));
            }
            //module
            for (var moduleName in this.config.interfaces.module) {
                for (var typeName in this.config.interfaces.module[moduleName]) {
                    var iface = this.config.interfaces.module[moduleName][typeName];
                    this.userInterfaces.push(new TSUserInterface(moduleName, typeName, iface));
                }
            }
        }
        private hoistPubliclyReferencedTypesToPublic(logger: ILogger): Dictionary<IOutputtable> {
            var publicTypes: Dictionary<IOutputtable> = {}; 
            var context = new TypeVisibilityContext();
            
            //First, visit all known public types and collect referenced types
            for (let typedef of this.userTypeAliases) {
                typedef.visit(context, this.config, logger);
            }
            for (let iface of this.userInterfaces) {
                iface.visit(context, this.config, logger);
            }
            for (let moduleName in this.moduleMembers) {
                let members = this.moduleMembers[moduleName];
                for (let member of members) {
                    member.visit(context, this.config, logger);
                }
            }
            for (let typeName in this.classes) {
                let cls = this.classes[typeName];
                if (cls.getIsPublic())
                    cls.visit(context, this.config, logger);
            }
            for (let typeName in this.typedefs) {
                let tdf = this.typedefs[typeName];
                if (tdf.getIsPublic())
                    tdf.visit(context, this.config, logger);
            }
            
            var userTypes = {};
            for (let typedef of this.userTypeAliases) {
                userTypes[typedef.getQualifiedName()] = typedef;
            }
            for (let iface of this.userInterfaces) {
                userTypes[iface.getQualifiedName()] = iface;
            }
            
            //Now that we've collected all referenced types, see what isn't public and
            //make them public
            //
            //Each type that is encountered is checked if it is public, if it is not
            //public then the type is "promoted" to public and its referenced types are
            //added to the context. At the same time, each type that has been checked
            //is removed from the context
            //
            //We repeat this process until the context is empty
            //
            //But before we start, auto-hoist any type in the "makePublic" list 
            for (var typeName of this.config.makePublic) {
                console.log(`Checking if (${typeName}) needs to be hoisted`);
                if (this.classes[typeName]) {
                    let cls = this.classes[typeName];
                    if (!cls.getIsPublic()) {
                        //logger.warn(`class (${typeName}) is referenced in one or more public APIs, but itself is not public. Making this public`);
                        cls.setIsPublic(true);
                        console.log(`Hoisting (${typeName}) to public API`);
                        //Have to visit to we know what extra types to check for
                        cls.visit(context, this.config, logger);
                    }
                } else if (this.typedefs[typeName]) {
                    let tdf = this.typedefs[typeName];
                    if (!tdf.getIsPublic()) {
                        //logger.warn(`typedef (${typeName}) is referenced in one or more public APIs, but itself is not public. Making this public`);
                        tdf.setIsPublic(true);
                        console.log(`Hoisting (${typeName}) to public API`);
                        //Have to visit so we know what extra types to check for
                        tdf.visit(context, this.config, logger);
                    }
                }
            }
            
            var pass = 1;
            while (!context.isEmpty()) {
                //NOTE: This is an array copy. Any new types added in this
                //pass should not affect the iterated array
                var allTypes = context.getTypes();
                //console.log(`Pass ${pass}: ${allTypes.length} types remaining to check`);
                for (let typeName of allTypes) {
                    //console.log(`Checking type: ${typeName}`);
                    if (this.classes[typeName]) {
                        let cls = this.classes[typeName];
                        if (!cls.getIsPublic()) {
                            logger.warn(`class (${typeName}) is referenced in one or more public APIs, but itself is not public. Making this public`);
                            cls.setIsPublic(true);
                            //Have to visit to we know what extra types to check for
                            cls.visit(context, this.config, logger);
                        } else {
                            publicTypes[cls.getFullName()] = cls;
                        }
                    } else if (this.typedefs[typeName]) {
                        let tdf = this.typedefs[typeName];
                        if (!tdf.getIsPublic()) {
                            logger.warn(`typedef (${typeName}) is referenced in one or more public APIs, but itself is not public. Making this public`);
                            tdf.setIsPublic(true);
                            //Have to visit so we know what extra types to check for
                            tdf.visit(context, this.config, logger);
                        } else {
                            publicTypes[tdf.getFullName()] = tdf;
                        }
                    } else if (userTypes[typeName]) {
                        //If the user defines a type, it means they want said type on
                        //the public API surface already. Nothing to do here.
                        publicTypes[userTypes[typeName]] = userTypes[typeName];
                    } else {
                        //TODO: Generate "any" type alias
                        //TODO: But only if it is not a built-in type (eg. A DOM class)
                        logger.warn(`Type (${typeName}) is referenced in one or more public APIs, but no definition for this type found`);
                    }
                    //Type has been checked, remove from context
                    context.removeType(typeName);
                }
                pass++;
            }
            
            return publicTypes;
        }
        private static ensureModuleTree(root: ITSModule, moduleNameParts: string[]): ITSModule {
            var tree: ITSModule = root;
            var i = 0;
            for (var name of moduleNameParts) {
                //Doesn't exist at this level, make it
                if (!tree.children[name]) {
                    tree.children[name] = {
                        isRoot: (i == 0),
                        children: {},
                        types: []
                    }
                }
                tree = tree.children[name];
                i++;
            }
            return tree;
        }
        
        private putDefinitionInTree(type: IOutputtable, moduleName: string, root: ITSModule): boolean {
            if (moduleName == null) {
                if (TypeUtil.isTsElementNotPublic(type)) {
                    return false;
                }
                root.types.push(type);
                return true;
            } else {
                let moduleNameClean = ModuleUtils.cleanModuleName(moduleName);
                //Before we put the definition in, if it is a function or constant and its parent module is private or
                //configured to be ignored, skip it.
                let bIgnoreThisType = (type.getKind() == TSOutputtableKind.Method || type.getKind() == TSOutputtableKind.Property) &&
                    (
                        (this.moduleDoclets[moduleNameClean] != null && TypeUtil.isPrivateDoclet(this.moduleDoclets[moduleNameClean], this.config)) ||
                        (this.config.ignoreModules.indexOf(moduleNameClean) >= 0)
                    );
                if (bIgnoreThisType) {
                    return false;
                }
                
                if (TypeUtil.isTsElementNotPublic(type)) {
                    return false;
                }
                
                if (ModuleUtils.isAMD(moduleNameClean)) {
                    //No nesting required for AMD modules
                    if (!root.children[moduleNameClean]) {
                        root.children[moduleNameClean] = {
                            isRoot: true,
                            children: {},
                            types: []
                        }
                    }
                    root.children[moduleNameClean].types.push(type);
                    return true;
                } else {
                    //Explode this module name and see how many levels we need to go
                    var moduleNameParts = moduleNameClean.split(".");
                    var tree = TsdGenerator.ensureModuleTree(root, moduleNameParts);
                    tree.types.push(type);
                    return true;
                }
            }
        }
        /**
         * This method groups all of our collected TS types according to their parent module
         */
        private assembleModuleTree(): ITSModule {
            let root: ITSModule = {
                isRoot: null,
                children: {},
                types: []
            };
            for (let typedef of this.userTypeAliases) {
                let moduleName = typedef.getParentModule();
                if (this.putDefinitionInTree(typedef, moduleName, root) === true)
                    this.stats.typedefs.user++;
            }
            for (let iface of this.userInterfaces) {
                let moduleName = iface.getParentModule();
                if (this.putDefinitionInTree(iface, moduleName, root) === true)
                    this.stats.ifaces++;
            }
            for (let oType of this.globalMembers) {
                //console.log(`Adding ${oType.getFullName()} to global namespace`);
                if (oType instanceof TSMember && !oType.getIsPublic())
                    continue;
                if (oType instanceof TSComposable && !oType.getIsPublic())
                    continue;
                root.types.push(oType);
            }
            for (let modName in this.moduleMembers) {
                let members = this.moduleMembers[modName];
                for (let member of members) {
                    if (this.putDefinitionInTree(member, modName, root) === true)
                        this.stats.moduleMembers++;
                }
            }
            for (let typeName in this.classes) {
                let cls = this.classes[typeName];
                if (!cls.getIsPublic())
                    continue;
                console.log(`Processing class: ${typeName}`);
                let moduleName = cls.getParentModule();
                if (this.putDefinitionInTree(cls, moduleName, root) === true)
                    this.stats.classes++;
            }
            for (let typeName in this.typedefs) {
                let tdf = this.typedefs[typeName];
                if (!tdf.getIsPublic())
                    continue;
                console.log(`Processing typedef: ${typeName}`);
                let moduleName = tdf.getParentModule();
                if (this.putDefinitionInTree(tdf, moduleName, root) === true)
                    this.stats.typedefs.gen++;
            }
            return root;
        }
        
        public dumpDoclets(doclets: IDoclet[], streamFactory: IFileStreamFactory) {
            var fileName = `${this.config.outDir}/${this.config.rootModuleName}.doclets.txt`;
            var output = new IndentedOutputStream(streamFactory.createStream(fileName), streamFactory.endl);
            
            for (var doc of doclets) {
                output.writeln(DumpDoclet(doc));
            }
            
            output.close(() => {
                console.log(`Saved dumped doclets to: ${fileName}`);
            });
        }
        
        public process(doclets: IDoclet[], streamFactory: IFileStreamFactory, logger: ILogger): void {
            var fileName = `${this.config.outDir}/${this.config.rootModuleName}.d.ts`;
            var output = new IndentedOutputStream(streamFactory.createStream(fileName), streamFactory.endl);
            
            //1st pass
            this.parseClassesAndTypedefs(doclets);
            //2nd pass. We process modules in this pass instead of the 1st so that enums do not get double-registered as modules as well
            this.parseModules(doclets);
            //3rd pass
            this.processTypeMembers(doclets);
            //Process user-defined types
            this.processUserDefinedTypes();
            //Raise any non-public types referenced from public types to public
            var publicTypes = this.hoistPubliclyReferencedTypesToPublic(logger);
            
            //Write custom header if specified
            if (this.config.headerFile != null) {
                var header = streamFactory.readText(this.config.headerFile);
                output.writeln(header);
            }
            
            //Write the main d.ts body
            var tree = this.assembleModuleTree();
            for (let i = 0; i < this.config.initialIndentation; i++) {
                output.indent();
            }
            ModuleUtils.outputTsd(tree, output, this.config, logger, publicTypes);
            for (let i = 0; i < this.config.initialIndentation; i++) {
                output.unindent();
            }
            
            //Write custom footer if specified
            if (this.config.headerFile != null) {
                var footer = streamFactory.readText(this.config.footerFile);
                output.writeln(footer);
            }
            
            output.close(() => {
                console.log("Wrote:");
                console.log(`  ${this.stats.typedefs.user} user-specified typedefs`);
                console.log(`  ${this.stats.ifaces} user-specified interfaces`);
                console.log(`  ${this.stats.moduleMembers} module members`);
                console.log(`  ${this.stats.typedefs.gen} scanned typedefs`);
                console.log(`  ${this.stats.classes} scanned classes`);
                console.log(`Saved TypeScript definition file to: ${fileName}`);
            });
        }
    }
}