#!/usr/bin/env python3
"""Deterministic, dependency-free Xcode project generator; never touches signing accounts."""
from pathlib import Path
import hashlib
ROOT = Path(__file__).resolve().parents[1]
objects = {}
def ident(name): return hashlib.sha256(name.encode()).hexdigest()[:24].upper()
def add(key_name, isa, **values):
    key = ident(key_name); objects[key] = dict(isa=isa, **values); return key

def encode(value, indent=0):
    import json
    if isinstance(value, dict):
        return '{\n' + ''.join('\t'*(indent+1) + json.dumps(str(k)) + ' = ' + encode(v,indent+1) + ';\n' for k,v in value.items()) + '\t'*indent + '}'
    if isinstance(value, list): return '(\n' + ''.join('\t'*(indent+1)+encode(v,indent+1)+',\n' for v in value) + '\t'*indent + ')'
    if isinstance(value,int): return str(value)
    return json.dumps(str(value), ensure_ascii=False)

source_builds=[]; refs=[]
for file in sorted((ROOT/'App').rglob('*.swift')):
    path=file.relative_to(ROOT).as_posix()
    ref=add('file:'+path,'PBXFileReference',lastKnownFileType='sourcecode.swift',path=path,sourceTree='<group>')
    refs.append(ref)
    source_builds.append(add('build:'+path,'PBXBuildFile',fileRef=ref))
resources=[]
for path in ['Config/PrivacyInfo.xcprivacy','Config/Assets.xcassets','Config/ThirdPartyNotices.txt']:
    if (ROOT/path).exists():
        ref=add('file:'+path,'PBXFileReference',lastKnownFileType='folder.assetcatalog' if path.endswith('xcassets') else 'text.xml',path=path,sourceTree='<group>')
        refs.append(ref); resources.append(add('build:'+path,'PBXBuildFile',fileRef=ref))
product=add('product','PBXFileReference',explicitFileType='wrapper.application',includeInIndex=0,path='HeyunaWallet.app',sourceTree='BUILT_PRODUCTS_DIR')
products=add('products','PBXGroup',children=[product],name='Products',sourceTree='<group>')
main=add('main-group','PBXGroup',children=refs+[products],sourceTree='<group>')
package=add('package','XCLocalSwiftPackageReference',relativePath='.')
package_product=add('package-product','XCSwiftPackageProductDependency',package=package,productName='WalletKit')
frameworks=add('frameworks','PBXFrameworksBuildPhase',buildActionMask=2147483647,files=[add('walletkit-link','PBXBuildFile',productRef=package_product)],runOnlyForDeploymentPostprocessing=0)
sources=add('sources','PBXSourcesBuildPhase',buildActionMask=2147483647,files=source_builds,runOnlyForDeploymentPostprocessing=0)
resources_phase=add('resources','PBXResourcesBuildPhase',buildActionMask=2147483647,files=resources,runOnlyForDeploymentPostprocessing=0)
common={
    'PRODUCT_BUNDLE_IDENTIFIER':'com.heyuna.wallet', 'PRODUCT_NAME':'HeyunaWallet',
    'INFOPLIST_FILE':'Config/Info.plist', 'GENERATE_INFOPLIST_FILE':'NO', 'SWIFT_VERSION':'5.0',
    'SUPPORTED_PLATFORMS':'iphoneos iphonesimulator macosx', 'SDKROOT':'auto',
    'IPHONEOS_DEPLOYMENT_TARGET':'17.0', 'MACOSX_DEPLOYMENT_TARGET':'15.5',
    'TARGETED_DEVICE_FAMILY':'1,2', 'SUPPORTS_MACCATALYST':'NO',
    'ENABLE_DEBUG_DYLIB':'NO', 'ENABLE_HARDENED_RUNTIME':'YES', 'ENABLE_APP_SANDBOX':'YES', 'ENABLE_OUTGOING_NETWORK_CONNECTIONS':'YES',
    'CODE_SIGN_STYLE':'Automatic', 'CODE_SIGN_ENTITLEMENTS[sdk=macosx*]':'Config/macOS.entitlements',
    'CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]':'Config/iOS.entitlements',
    'CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]':'Config/iOS.entitlements',
    'SWIFT_EMIT_LOC_STRINGS':'YES', 'ENABLE_USER_SCRIPT_SANDBOXING':'YES',
    'LD_RUNPATH_SEARCH_PATHS':'$(inherited) @executable_path/../Frameworks @executable_path/Frameworks',
    'ASSETCATALOG_COMPILER_APPICON_NAME':'AppIcon', 'MARKETING_VERSION':'0.1.0', 'CURRENT_PROJECT_VERSION':'1'
}
configs=[]
for name in ['Debug','Release']:
    settings=dict(common, SWIFT_OPTIMIZATION_LEVEL='-Onone' if name=='Debug' else '-O',DEBUG_INFORMATION_FORMAT='dwarf' if name=='Debug' else 'dwarf-with-dsym', ONLY_ACTIVE_ARCH='YES' if name=='Debug' else 'NO')
    if name=='Debug': settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS']='$(inherited) DEBUG'
    configs.append(add('target-config:'+name,'XCBuildConfiguration',name=name,buildSettings=settings))
targetlist=add('target-config-list','XCConfigurationList',buildConfigurations=configs,defaultConfigurationIsVisible=0,defaultConfigurationName='Release')
target=add('target','PBXNativeTarget',buildConfigurationList=targetlist,buildPhases=[sources,frameworks,resources_phase],buildRules=[],dependencies=[],name='HeyunaWallet',packageProductDependencies=[package_product],productName='HeyunaWallet',productReference=product,productType='com.apple.product-type.application')
# Native UI regression tests run on an isolated simulator or macOS test host.
ui_ref=add('ui-source','PBXFileReference',lastKnownFileType='sourcecode.swift',path='UITests/WalletAppUITests.swift',sourceTree='<group>')
objects[main]['children'].append(ui_ref)
ui_product=add('ui-product','PBXFileReference',explicitFileType='wrapper.cfbundle',includeInIndex=0,path='WalletAppUITests.xctest',sourceTree='BUILT_PRODUCTS_DIR')
objects[products]['children'].append(ui_product)
ui_configs=[]
for name in ['Debug','Release']:
    ui_configs.append(add('ui-config:'+name,'XCBuildConfiguration',name=name,buildSettings={
        'PRODUCT_BUNDLE_IDENTIFIER':'com.heyuna.wallet.uitests','PRODUCT_NAME':'$(TARGET_NAME)',
        'GENERATE_INFOPLIST_FILE':'YES','SWIFT_VERSION':'5.0','SDKROOT':'auto',
        'SUPPORTED_PLATFORMS':'iphoneos iphonesimulator macosx','TARGETED_DEVICE_FAMILY':'1,2',
        'IPHONEOS_DEPLOYMENT_TARGET':'17.0','MACOSX_DEPLOYMENT_TARGET':'15.5',
        'TEST_TARGET_NAME':'HeyunaWallet','CODE_SIGN_STYLE':'Automatic'
    }))
ui_list=add('ui-config-list','XCConfigurationList',buildConfigurations=ui_configs,defaultConfigurationIsVisible=0,defaultConfigurationName='Release')
ui_sources=add('ui-sources','PBXSourcesBuildPhase',buildActionMask=2147483647,files=[add('ui-build-file','PBXBuildFile',fileRef=ui_ref)],runOnlyForDeploymentPostprocessing=0)
ui_frameworks=add('ui-frameworks','PBXFrameworksBuildPhase',buildActionMask=2147483647,files=[],runOnlyForDeploymentPostprocessing=0)
ui_dep=add('ui-app-dependency','PBXTargetDependency',target=target)
ui_target=add('ui-target','PBXNativeTarget',buildConfigurationList=ui_list,buildPhases=[ui_sources,ui_frameworks],buildRules=[],dependencies=[ui_dep],name='WalletAppUITests',productName='WalletAppUITests',productReference=ui_product,productType='com.apple.product-type.bundle.ui-testing')

projectconfigs=[]
for name in ['Debug','Release']:
    projectconfigs.append(add('project-config:'+name,'XCBuildConfiguration',name=name,buildSettings={'CLANG_ENABLE_MODULES':'YES','CLANG_ENABLE_OBJC_ARC':'YES','SWIFT_STRICT_CONCURRENCY':'complete','ENABLE_STRICT_OBJC_MSGSEND':'YES','GCC_C_LANGUAGE_STANDARD':'gnu17','CLANG_CXX_LANGUAGE_STANDARD':'gnu++20','SWIFT_TREAT_WARNINGS_AS_ERRORS':'NO'}))
projectlist=add('project-config-list','XCConfigurationList',buildConfigurations=projectconfigs,defaultConfigurationIsVisible=0,defaultConfigurationName='Release')
project=add('project','PBXProject',attributes={'BuildIndependentTargetsInParallel':'YES','LastUpgradeCheck':'2700', 'TargetAttributes':{ui_target:{'TestTargetID':target}}},buildConfigurationList=projectlist,compatibilityVersion='Xcode 15.0',developmentRegion='zh-Hans',hasScannedForEncodings=0,knownRegions=['zh-Hans','en','Base'],mainGroup=main,packageReferences=[package],productRefGroup=products,projectDirPath='',projectRoot='',targets=[target,ui_target])
projectdir=ROOT/'HeyunaWallet.xcodeproj'
projectdir.mkdir(exist_ok=True)
(projectdir/'project.pbxproj').write_text('// !$*UTF8*$!\n'+encode({'archiveVersion':1,'classes':{},'objectVersion':60,'objects':objects,'rootObject':project})+'\n')
schemedir=projectdir/'xcshareddata/xcschemes';schemedir.mkdir(parents=True,exist_ok=True)
(schemedir/'HeyunaWallet.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="HeyunaWallet.app" BlueprintName="HeyunaWallet" ReferencedContainer="container:HeyunaWallet.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ui_target}" BuildableName="WalletAppUITests.xctest" BlueprintName="WalletAppUITests" ReferencedContainer="container:HeyunaWallet.xcodeproj"/></TestableReference></Testables></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="HeyunaWallet.app" BlueprintName="HeyunaWallet" ReferencedContainer="container:HeyunaWallet.xcodeproj"/></BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="HeyunaWallet.app" BlueprintName="HeyunaWallet" ReferencedContainer="container:HeyunaWallet.xcodeproj"/></BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''')
print(f'Generated Xcode project with {len(source_builds)} Swift files.')
