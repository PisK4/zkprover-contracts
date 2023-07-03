import { BigNumber, PopulatedTransaction, Wallet } from 'ethers'
import { ethers } from 'hardhat'
import { expect } from 'chai'
import {
  Account,
  EntryPoint,
  EntryPoint__factory,
  VerifyingPaymaster,
  VerifyingPaymaster__factory,
  AccountFactory,
  AccountFactory__factory,
  ZkProverZkpVerifierWrapper,
  ZkProverZkpVerifierWrapper__factory,
  TestToken,
  TestToken__factory
} from '../typechain-types'
import {
  createAccountOwner,
  fund,
  createAddress,
  createAccount,
  simulationResultCatch,
  MOCK_VALID_AFTER,
  MOCK_VALID_UNTIL
} from './testutils'
import { fillAndSign } from './UserOp'
import { defaultAbiCoder, hexConcat } from 'ethers/lib/utils'
import { arrayify,hexValue } from '@ethersproject/bytes'
import { compile_yul, halo2zkpVerifierAbi } from '../scripts/utils'
import ProofData from "./zkp_output/proof.json";
import { randomInt } from 'crypto'
import { Console } from 'console'
import { Test } from 'mocha'

describe('4.createAccount.test', function () {
  let entryPoint: EntryPoint
  let accountOwner: Wallet
  let accountOwner2: Wallet
  const ethersSigner = ethers.provider.getSigner()
  const ethersSignerAdmin = ethers.provider.getSigner(1)
  let account: Account
  let factory: AccountFactory
  let paymaster: VerifyingPaymaster
  let verifier: ZkProverZkpVerifierWrapper
  let token: TestToken
  const otherAddr = createAddress()
  let ownerAddr: string
  let pmAddr: string
  let created = false
  const beneficiaryAddress = createAddress()
  const _saltAccount = randomInt(0,50)
  const _saltAccount2 = randomInt(50,100)

  function getAccountDeployer(
    // entryPoint: string,
    _accountOwner: string,
    _salt: number
  ): string {
    return hexConcat([
      factory.address,
      hexValue(
        factory.interface.encodeFunctionData('createAccount', [
          _accountOwner,
          _salt
        ])!
      )
    ])
  }

  async function isDeployed(addr: string): Promise<boolean> {
    const code = await ethers.provider.getCode(addr)
    return code.length > 2
  }

  before(async () => {
    let verifyCode = await compile_yul("contracts/zkp/zkpVerifier.yul");
      const ContractFactory = new ethers.ContractFactory(
          halo2zkpVerifierAbi,
          verifyCode,
          ethersSigner
        );
        const verifyContract = await ContractFactory.deploy();
      verifier = await new ZkProverZkpVerifierWrapper__factory(
        ethersSigner
        ).deploy(verifyContract.address);
      entryPoint = await new EntryPoint__factory(ethersSigner).deploy(verifier.address)
      paymaster = await new VerifyingPaymaster__factory(ethersSigner).deploy(
        entryPoint.address,
        await ethersSigner.getAddress())
      pmAddr = paymaster.address
      ownerAddr = await ethersSigner.getAddress()
      factory = await new AccountFactory__factory(ethersSigner).deploy(
        entryPoint.address
      )
      token = await new TestToken__factory(ethersSigner).deploy()
      console.log('factory addr:%s, paymaster addr:%s', factory.address, paymaster.address)
  
      accountOwner = createAccountOwner()
      ;({ proxy: account } = await createAccount(
        ethersSigner,
        await accountOwner.getAddress(),
        entryPoint.address,
        factory
      ))
      await fund(account)
      accountOwner2 = createAccountOwner()
      // ;({ proxy: account } = await createAccount(
      //   ethersSigner,
      //   await accountOwner2.getAddress(),
      //   entryPoint.address,
      //   factory
      // ))
      // await fund(account)
    })

    it('create account by EOA', async () => {
      let accountOwnerEOA = createAccountOwner()
      const _salt = randomInt(0,50)
      const tx = await factory.createAccount(
        accountOwnerEOA.address,
        _salt,
        {
          maxFeePerGas: 1e9,
          gasLimit: 30000000,
        }).then(async (t) => await t.wait())

      console.log(
        'EOA create account gasused:',
         tx.gasUsed.toString()
      )

    })

    it('should fail if we create sender with error initcode ', async () => {
        const userOp = await fillAndSign(
          {
            initCode:  '0x' + '11'.repeat(65),
            sig: '0x' + '00'.repeat(65)
          },
          accountOwner2,
          entryPoint
        )

        await expect( entryPoint.handleOps([userOp],        
          ProofData.proof,
          [BigNumber.from(ProofData.pub_ins[0])], 
          beneficiaryAddress,
          {
            maxFeePerGas: 1e9,
            gasLimit: 30000000,
          }))
          .to.reverted
    })


    it('should succeed to create account with paymaster', async () => {

      await paymaster.deposit({ value: ethers.utils.parseEther('1') })
      const userOp1 = await fillAndSign(
        {
          initCode: getAccountDeployer(
              accountOwner.address,
              _saltAccount
          ),
          paymasterAndData: hexConcat([
            paymaster.address,
            defaultAbiCoder.encode(
              ['uint48', 'uint48', 'address', 'uint256'],
              [MOCK_VALID_UNTIL, MOCK_VALID_AFTER, token.address, 0]
  
            ),
            '0x' + '00'.repeat(65)
          ])
        },
        accountOwner,
        entryPoint
      )
      const hash = await paymaster.getHash(
        userOp1,
        MOCK_VALID_UNTIL,
        MOCK_VALID_AFTER,
        token.address,
        0
      )
      const sig = await ethersSigner.signMessage(arrayify(hash))
      const userOp = await fillAndSign(
        {
          ...userOp1,
          paymasterAndData: hexConcat([
            paymaster.address,
            defaultAbiCoder.encode(
              ['uint48', 'uint48', 'address', 'uint256'],
              [MOCK_VALID_UNTIL, MOCK_VALID_AFTER, token.address, 0]
            ),
            sig
          ])
        },
        accountOwner,
        entryPoint
      )

      const res = await entryPoint.callStatic
          .simulateValidation(userOp)
          .catch(simulationResultCatch)
          
      expect(res.returnInfo.sigFailed).to.be.false
      expect(res.returnInfo.validAfter).to.be.equal(
        ethers.BigNumber.from(MOCK_VALID_AFTER)
      )
      expect(res.returnInfo.validUntil).to.be.equal(
        ethers.BigNumber.from(MOCK_VALID_UNTIL)
      )
      created = true

      const tx = await entryPoint.handleOps([userOp],        
        ProofData.proof,
        [BigNumber.from(ProofData.pub_ins[0])], 
        beneficiaryAddress,
        {
          maxFeePerGas: 1e9,
          gasLimit: 30000000,
        })
        .then(async (t) => await t.wait())

      // listeaning to events
      const [logs] = await entryPoint.queryFilter(
        entryPoint.filters.AccountDeployed())
      expect(logs.args.paymaster).to.be.equal(pmAddr)
      expect(logs.args.factory).to.be.equal(factory.address)

      const createAccountAddr = await factory.callStatic.getAddress(
        accountOwner.address,
        _saltAccount
      )
      console.log('createAccountAddr:', createAccountAddr)
      expect(logs.args.sender).to.be.equal(createAccountAddr)
      expect(
        await ethers.provider.getCode(createAccountAddr).then((x) => x.length)
      ).to.be.greaterThan(3)

      console.log(
        'creare account gasused:',
        tx.gasUsed.toString()
      )

    })

    it('should succeed to create account with EOA payGas', async () => {
      const userOp = await fillAndSign(
        {
          initCode: getAccountDeployer(
              accountOwner2.address,
              _saltAccount2
          ),
        },
        accountOwner2,
        entryPoint
      )

      const createAccountAddr = await factory.callStatic.getAddress(
        accountOwner2.address,
        _saltAccount2
      )      

      await fund(createAccountAddr)

      // const res = await entryPoint.callStatic
      //     .simulateValidation(userOp)
      //     .catch(simulationResultCatch)
        

      const tx = await entryPoint.handleOps([userOp],        
        ProofData.proof,
        [BigNumber.from(ProofData.pub_ins[0])], 
        beneficiaryAddress,
        {
          maxFeePerGas: 1e9,
          gasLimit: 30000000,
        })
        .then(async (t) => await t.wait())

      expect(
        await ethers.provider.getCode(createAccountAddr).then((x) => x.length)
      ).to.be.greaterThan(3)

      console.log(
        'create account gasused:',
        tx.gasUsed.toString()
      )

    })

    it('test createAccount & transfer in one op with paymaster', async () => {
      let preaddress = createAddress();
      let preaddress2 = createAddress();
      let accountOwnerEOA = createAccountOwner()
      let erc20TransfercallData: PopulatedTransaction
      const _salt = randomInt(0,50);

      await token.mint(preaddress, 10)
      await token.transfer(preaddress2, 10)
      await paymaster.deposit({ value: ethers.utils.parseEther('1') })
  
      const transfercallData = await token.populateTransaction.transfer(
        beneficiaryAddress,
        10
      )
  
      erc20TransfercallData = await account.populateTransaction.execute(
        token.address,
        0,
        transfercallData.data!
      )

      const userOp1 = await fillAndSign(
        {
          callData: erc20TransfercallData.data,
          initCode: getAccountDeployer(
            accountOwnerEOA.address,
              _salt
          ),
          callGasLimit: 1e6,
          paymasterAndData: hexConcat([
            paymaster.address,
            defaultAbiCoder.encode(
              ['uint48', 'uint48', 'address', 'uint256'],
              [MOCK_VALID_UNTIL, MOCK_VALID_AFTER, token.address, 0]
            ),
            '0x' + '00'.repeat(65)
          ])
        },
        accountOwnerEOA,
        entryPoint
      )
      const hash = await paymaster.getHash(
        userOp1,
        MOCK_VALID_UNTIL,
        MOCK_VALID_AFTER,
        token.address,
        0
      )
      const sig = await ethersSignerAdmin.signMessage(arrayify(hash))
      const userOp = await fillAndSign(
        {
          ...userOp1,
          paymasterAndData: hexConcat([
            paymaster.address,
            defaultAbiCoder.encode(
              ['uint48', 'uint48', 'address', 'uint256'],
              [MOCK_VALID_UNTIL, MOCK_VALID_AFTER, token.address, 0]
            ),
            sig
          ])
        },
        accountOwnerEOA,
        entryPoint
      )

      const createAccountAddr = await factory.callStatic.getAddress(
        accountOwnerEOA.address,
        _salt
      )      

      await fund(createAccountAddr)
      await entryPoint.depositTo(createAccountAddr,{ value: ethers.utils.parseEther('1') })
      await token.mint(createAccountAddr, 10)
        
      const tx = await entryPoint.handleOps([userOp],        
        ProofData.proof,
        [BigNumber.from(ProofData.pub_ins[0])], 
        beneficiaryAddress,
        {
          maxFeePerGas: 1e9,
          gasLimit: 30000000,
        })
        .then(async (t) => await t.wait())

      expect(
        await ethers.provider.getCode(createAccountAddr).then((x) => x.length)
      ).to.be.greaterThan(3)

      console.log(
        'create account gasused:',
        tx.gasUsed.toString()
      )      

      expect(await token.balanceOf(beneficiaryAddress)).to.be.greaterThanOrEqual(10)

    })

    it('test createAccount & transfer in one op without paymaster', async () => {
      let preaddress = createAddress();
      let preaddress2 = createAddress();
      let accountOwnerEOA = createAccountOwner()
      let erc20TransfercallData: PopulatedTransaction
      const _salt = randomInt(50,100);

      await token.mint(preaddress, 10)
      await token.transfer(preaddress2, 10)
  
      const transfercallData = await token.populateTransaction.transfer(
        beneficiaryAddress,
        10
      )
  
      erc20TransfercallData = await account.populateTransaction.execute(
        token.address,
        0,
        transfercallData.data!
      )

      const userOp = await fillAndSign(
        {
          callData: erc20TransfercallData.data,
          initCode: getAccountDeployer(
            accountOwnerEOA.address,
              _salt
          ),
          callGasLimit: 1e6,
        },
        accountOwnerEOA,
        entryPoint
      )

      const createAccountAddr = await factory.callStatic.getAddress(
        accountOwnerEOA.address,
        _salt
      )      

      await fund(createAccountAddr)
      await entryPoint.depositTo(createAccountAddr,{ value: ethers.utils.parseEther('1') })
      await token.mint(createAccountAddr, 10)
        
      const tx = await entryPoint.handleOps([userOp],        
        ProofData.proof,
        [BigNumber.from(ProofData.pub_ins[0])], 
        beneficiaryAddress,
        {
          maxFeePerGas: 1e9,
          gasLimit: 30000000,
        })
        .then(async (t) => await t.wait())

      expect(
        await ethers.provider.getCode(createAccountAddr).then((x) => x.length)
      ).to.be.greaterThan(3)

      console.log(
        'create account gasused:',
        tx.gasUsed.toString()
      )      

      expect(await token.balanceOf(beneficiaryAddress)).to.be.greaterThanOrEqual(10)

    })    

})
