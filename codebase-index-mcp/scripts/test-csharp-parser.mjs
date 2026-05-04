import Parser from "tree-sitter";
import CSharpModule from "tree-sitter-c-sharp";

const CSharp = CSharpModule.default || CSharpModule;

console.log("CSharp parser:", typeof CSharp);
console.log("CSharp keys:", Object.keys(CSharp));
console.log("CSharp.language:", CSharp.language);
console.log("CSharp.language type:", typeof CSharp.language);

const parser = new Parser();
try {
  const lang = CSharp.language || CSharp;
  console.log("Using language:", typeof lang);
  parser.setLanguage(lang);
  console.log("✓ Parser set successfully");
  
  const code = `
using System;

namespace Test {
  public class MyClass {
    public void MyMethod() {
      Console.WriteLine("Hello");
    }
  }
}
`;
  
  const tree = parser.parse(code);
  console.log("\nRoot node type:", tree.rootNode.type);
  console.log("Child count:", tree.rootNode.childCount);
  
  const classes = tree.rootNode.descendantsOfType("class_declaration");
  console.log("\nFound classes:", classes.length);
  classes.forEach(c => {
    const name = c.childForFieldName("name");
    console.log("  Class:", name?.text || "unnamed");
  });
  
} catch (error) {
  console.error("✗ Error:", error.message);
}
